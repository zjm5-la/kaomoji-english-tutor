import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getRuntimeState, type PendingAttempt, type RuntimeState } from "./runtime-state.ts";
import { sentenceExercise, type SentenceExerciseView } from "./render.ts";
import type { ItemRow } from "./db.ts";

// -- Sentence exercise & cycle persistence ----------------------------------

export function ensureSentenceExercise(db: DatabaseSync, item: ItemRow, exercise: SentenceExerciseView): number {
	const fingerprint = createHash("sha256")
		.update(`sentence-output\0${item.id}\0${item.content_version ?? 1}\0${exercise.level}\0${exercise.reference}`)
		.digest("hex");
	db.prepare(
		"INSERT OR IGNORE INTO exercises (item_id, kind, schema_version, stage, content_fingerprint, prompt_json, answer_json, hints_json, rubric_json, quality_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, '{}', ?)",
	).run(
		item.id,
		exercise.kind,
		"L" + (exercise.level + 1),
		fingerprint,
		JSON.stringify({ chinese: exercise.chinese, cloze: exercise.cloze, focusExpression: exercise.focusExpression }),
		JSON.stringify({ reference: exercise.reference, expected: exercise.expected }),
		JSON.stringify([exercise.hint]),
		JSON.stringify({ semanticMatch: exercise.kind === "sentence_production", requireNaturalEnglish: true }),
		new Date().toISOString(),
	);
	const row = db.prepare("SELECT id FROM exercises WHERE content_fingerprint = ?").get(fingerprint) as { id: number };
	return Number(row.id);
}

export function insertEvaluatedAttempt(
	db: DatabaseSync,
	attempt: PendingAttempt,
	explicitRating: "good" | "again" | null,
	now: Date,
): void {
	const reviewCycleId = attempt.reviewCycleId ?? randomUUID();
	const kind = attempt.kind ?? "recall";
	const claimKey = attempt.reviewCycleId
		? `${kind}:${reviewCycleId}:${attempt.version}`
		: `recall:${attempt.itemId}:${randomUUID()}`;
	const feedback = attempt.feedback || attempt.correctedAnswer
		? JSON.stringify({ feedback: attempt.feedback, correctedAnswer: attempt.correctedAnswer })
		: null;
	db.prepare(
		"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, answer_text, assistance_level, status, verdict, error_tags_json, feedback_json, explicit_rating, started_at, completed_at, rated_at, question_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		randomUUID(), attempt.itemId, attempt.exerciseId ?? null, reviewCycleId, claimKey,
		attempt.version, attempt.version, kind, attempt.direction, attempt.answerText, attempt.assistanceLevel,
		"evaluated", attempt.verdict, attempt.errorTags?.length ? JSON.stringify(attempt.errorTags) : null,
		feedback, explicitRating, attempt.startedAt, now.toISOString(), explicitRating ? now.toISOString() : null,
		attempt.questionText ?? null,
	);
}

/** Lazily attach an authoritative sentence-output cycle to the global card slot. */
export function ensureSentenceCycle(db: DatabaseSync, item: ItemRow, state: RuntimeState): RuntimeState {
	if (item.type !== "sentence" || state.active_item_id !== item.id) return state;
	const exercise = sentenceExercise(item);
	if (!exercise) return state;
	const exerciseId = ensureSentenceExercise(db, item, exercise);
	db.prepare(
		"UPDATE runtime_state SET active_direction = 'forward', active_review_cycle_id = COALESCE(active_review_cycle_id, ?), active_exercise_id = ?, active_cycle_outcome = COALESCE(active_cycle_outcome, 'clean'), active_retry_count = COALESCE(active_retry_count, 0), active_assistance_level = COALESCE(active_assistance_level, 'none') WHERE id = 1 AND active_item_id = ? AND active_version = ?",
	).run(randomUUID(), exerciseId, item.id, state.active_version);
	return getRuntimeState(db);
}
