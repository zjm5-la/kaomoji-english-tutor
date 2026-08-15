import { FSRS, Rating, Card, State } from "fsrs.js";
import type { DatabaseSync } from "node:sqlite";
import { EMPTY_SENTENCE_CYCLE, getRuntimeState, setRuntimeState, type AssistanceLevel } from "./runtime-state.ts";

// -- FSRS scheduling ------------------------------------------------------

const scheduler = new FSRS();

/**
 * Assistance-aware scheduling policy for word/phrase recall (P0-2).
 * Objective evidence ranks above self-report; assistance caps the rating:
 * - unassisted objective correct -> Good (miss stays Again)
 * - hint + correct -> at most Hard
 * - revealed/flipped + correct -> Again
 * - manual /kaomoji:good without an objective answer -> at most Hard
 *   (self-report is recorded separately and never counts as unassisted evidence)
 * Sentence cards do not use this policy; their stricter cycle logic is unchanged.
 */
export function effectiveRecallRating(args: {
	rating: Rating;
	assistance: AssistanceLevel;
	manual: boolean;
}): Rating {
	const { rating, assistance, manual } = args;
	if (rating !== Rating.Good) return rating;
	if (assistance === "revealed") return Rating.Again;
	if (assistance === "hint") return Rating.Hard;
	if (manual) return Rating.Hard;
	return Rating.Good;
}

/** Rebuild a Card from its stored JSON state (dates come back as strings).
 * Empty state is a valid new Card; non-empty malformed state is corruption. */
export function restoreCard(stateJson: string): { card: Card } | { corrupt: true; error: string } {
	if (!stateJson.trim()) return { card: new Card() };
	let parsed: Card;
	try {
		parsed = JSON.parse(stateJson) as Card;
	} catch (err) {
		return { corrupt: true, error: `json_parse: ${(err as Error).message}` };
	}
	if (parsed == null || typeof parsed !== "object") {
		return { corrupt: true, error: "not_object" };
	}
	const required: Array<[string, unknown]> = [
		["due", parsed.due],
		["stability", parsed.stability],
		["difficulty", parsed.difficulty],
		["elapsed_days", parsed.elapsed_days],
		["scheduled_days", parsed.scheduled_days],
		["reps", parsed.reps],
		["lapses", parsed.lapses],
		["state", parsed.state],
	];
	for (const [name, value] of required) {
		if (value == null) return { corrupt: true, error: `missing_field:${name}` };
		if (name !== "due" && (typeof value !== "number" || !Number.isFinite(value))) {
			return { corrupt: true, error: `invalid_field:${name}` };
		}
	}
	if (![State.New, State.Learning, State.Review, State.Relearning].includes(parsed.state)) {
		return { corrupt: true, error: "invalid_field:state" };
	}
	if (parsed.elapsed_days < 0) return { corrupt: true, error: "invalid_field:elapsed_days" };
	for (const [name, value] of [["scheduled_days", parsed.scheduled_days], ["reps", parsed.reps], ["lapses", parsed.lapses]] as const) {
		if (!Number.isInteger(value) || value < 0) return { corrupt: true, error: `invalid_field:${name}` };
	}
	if (parsed.stability < 0 || parsed.difficulty < 0 || parsed.difficulty > 10) {
		return { corrupt: true, error: "invalid_field:fsrs_range" };
	}
	if (parsed.state !== State.New && (parsed.stability <= 0 || parsed.difficulty < 1)) {
		return { corrupt: true, error: "invalid_field:review_range" };
	}
	const due = new Date(parsed.due);
	const lastReview = parsed.last_review ? new Date(parsed.last_review) : new Date(parsed.due);
	if (Number.isNaN(due.getTime())) return { corrupt: true, error: "invalid_date:due" };
	if (Number.isNaN(lastReview.getTime())) return { corrupt: true, error: "invalid_date:last_review" };
	const card = new Card();
	card.due = due;
	card.last_review = lastReview;
	card.stability = parsed.stability;
	card.difficulty = parsed.difficulty;
	card.elapsed_days = parsed.elapsed_days;
	card.scheduled_days = parsed.scheduled_days;
	card.reps = parsed.reps;
	card.lapses = parsed.lapses;
	card.state = parsed.state;
	return { card };
}

/** Advance a card only after an explicit user rating.
 * Passing null state creates the first schedule for a brand-new item.
 * Returns corrupt when the stored FSRS blob is malformed; callers must quarantine. */
export function scheduleNext(stateJson: string | null, now: Date, rating: Rating = Rating.Good): { state: string; due: string } | { corrupt: true; error: string } {
	if (!stateJson) {
		const info = scheduler.repeat(new Card(), now)[rating];
		return { state: JSON.stringify(info.card), due: info.card.due.toISOString() };
	}
	const restored = restoreCard(stateJson);
	if ("corrupt" in restored) return restored;
	try {
		const info = scheduler.repeat(restored.card, now)[rating];
		if (!info?.card || Number.isNaN(info.card.due.getTime())) {
			return { corrupt: true, error: "scheduler_invalid_due" };
		}
		for (const value of [info.card.stability, info.card.difficulty, info.card.elapsed_days, info.card.scheduled_days, info.card.reps, info.card.lapses]) {
			if (!Number.isFinite(value)) return { corrupt: true, error: "scheduler_invalid_field" };
		}
		return { state: JSON.stringify(info.card), due: info.card.due.toISOString() };
	} catch (err) {
		return { corrupt: true, error: `scheduler_error:${(err as Error).message}` };
	}
}

/** Atomically quarantine a corrupt FSRS item: preserve the raw blob, mark it corrupt,
 * insert one diagnostic row, and clear the active card slot. */
export function quarantineCorruptFsrs(db: DatabaseSync, itemId: number, rawFsrsState: string, error: string, now: Date): void {
	const ts = now.toISOString();
	const errCode = error.slice(0, 80);
	try {
		db.exec("BEGIN IMMEDIATE");
		const marked = db.prepare("UPDATE items SET fsrs_status = 'corrupt', fsrs_error = ?, fsrs_corrupt_at = ? WHERE id = ? AND fsrs_status IS NOT 'corrupt'")
			.run(errCode, ts, itemId);
		if (Number(marked.changes) > 0) {
			db.prepare(
				"INSERT INTO fsrs_corruptions (item_id, raw_fsrs_state, error_code, detected_at, resolution) VALUES (?, ?, ?, ?, NULL)",
			).run(itemId, rawFsrsState, errCode, ts);
		}
		// Clear the active card slot so the corrupt item is not re-surfaced.
		const cur = getRuntimeState(db);
		if (cur.active_item_id === itemId) {
			setRuntimeState(db, {
				active_item_id: null,
				active_kind: null,
				active_direction: "forward",
				active_version: cur.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				next_check_at: now.toISOString(),
			});
		}
		db.exec("COMMIT");
	} catch (err) {
		try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
		console.error(`[kaomoji-english-tutor] FSRS quarantine failed for item ${itemId}: ${err}`);
	}
}
