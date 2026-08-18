import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiSdkLlmClient } from "../pi-sdk-llm.ts";
import type { PetConfig } from "../config.ts";
import { appendGenLog, getGenLog, openDb, setStat } from "../db.ts";
import { insertEvaluatedAttempt } from "../sentence-cycle.ts";
import type { PendingAttempt } from "../runtime-state.ts";
import { critiqueLesson, evaluateAttempt, generateLesson, generateReplacement, type GeneratedItem } from "../llm.ts";
import {
	coldStartProfile,
	computeLearnerProfile,
	deriveBudget,
	formatAttemptLogBlock,
	recentAttemptLog,
	type AdaptiveContext,
} from "../learner-profile.ts";

// -- Test DB helpers ------------------------------------------------------

const NOW = new Date("2026-08-13T12:00:00.000Z");
const iso = (offsetMs = 0) => new Date(NOW.getTime() + offsetMs).toISOString();

interface DbHandle {
	db: ReturnType<typeof openDb>;
	close: () => void;
}

function freshDb(): DbHandle {
	const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-profile-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const db = openDb();
	return { db, close: () => { db.close(); rmSync(agentDir, { recursive: true, force: true }); } };
}

function insertWord(handle: DbHandle, text = `word-${randomUUID().slice(0, 6)}`): number {
	const r = handle.db
		.prepare("INSERT INTO items (type, text, meaning, learned_at, due_at) VALUES ('word', ?, ?, ?, ?)")
		.run(text, "释", iso(), iso());
	return Number(r.lastInsertRowid);
}

function insertSentenceExercise(handle: DbHandle, itemId: number, stage: string): number {
	const fp = `ex-${itemId}-${stage}-${randomUUID().slice(0, 6)}`;
	handle.db
		.prepare(
			"INSERT INTO exercises (item_id, kind, schema_version, stage, content_fingerprint, prompt_json, answer_json, hints_json, rubric_json, quality_json, created_at) " +
				"VALUES (?, 'sentence_production', 1, ?, ?, '{}', '{}', '[]', '{}', '{}', ?)",
		)
		.run(itemId, stage, fp, iso());
	return Number(handle.db.prepare("SELECT id FROM exercises WHERE content_fingerprint = ?").get(fp)!.id);
}

type Verdict = "correct" | "partial" | "incorrect";
type Assistance = "none" | "hint" | "revealed";

interface RecallOpts {
	itemId: number;
	direction: "forward" | "reverse" | null;
	verdict: Verdict;
	assistance?: Assistance;
	errorTags?: string[];
	completedAt?: string;
}

function insertRecall(handle: DbHandle, opts: RecallOpts): void {
	handle.db
		.prepare(
			"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, verdict, error_tags_json, started_at, completed_at) " +
				"VALUES (?, ?, NULL, ?, ?, 1, 1, 'recall', ?, ?, 'evaluated', ?, ?, ?, ?)",
		)
		.run(
			randomUUID(), opts.itemId, randomUUID(), randomUUID(), opts.direction, opts.assistance ?? "none",
			opts.verdict, opts.errorTags?.length ? JSON.stringify(opts.errorTags) : null, opts.completedAt ?? iso(), opts.completedAt ?? iso(),
		);
}

interface SentenceOpts {
	itemId: number;
	exerciseId: number;
	cycleId: string;
	verdict: Verdict;
	assistance?: Assistance;
	errorTags?: string[];
	startedAt: string;
	completedAt?: string;
}

function insertSentenceAttempt(handle: DbHandle, opts: SentenceOpts): void {
	handle.db
		.prepare(
			"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, verdict, error_tags_json, started_at, completed_at) " +
				"VALUES (?, ?, ?, ?, ?, 1, 1, 'sentence_production', 'forward', ?, 'evaluated', ?, ?, ?, ?)",
		)
		.run(
			randomUUID(), opts.itemId, opts.exerciseId, opts.cycleId, randomUUID(),
			opts.assistance ?? "none", opts.verdict, opts.errorTags?.length ? JSON.stringify(opts.errorTags) : null,
			opts.startedAt, opts.completedAt ?? opts.startedAt,
		);
}

// -- Tests ----------------------------------------------------------------

test("cold start: empty DB yields a B1 prior with null rates and a conservative budget", () => {
	const handle = freshDb();
	try {
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.syntax.band, "B1");
		assert.equal(profile.vocab.band, "B1");
		assert.equal(profile.syntax.confidence, "low");
		assert.equal(profile.vocab.confidence, "low");
		assert.equal(profile.syntax.rate, null);
		assert.equal(profile.recallForward.evidence, 0);
		assert.equal(profile.recallForward.rate, null);
		assert.equal(profile.recallReverse.rate, null);
		assert.equal(profile.sentence.rate, null);
		assert.equal(profile.assistance.rate, null);
		assert.deepEqual(profile.errorFocus, []);
		const budget = deriveBudget(profile);
		assert.deepEqual(budget.wordRange, [12, 18]);
		assert.equal(budget.maxKeyWords, 2);
		assert.equal(budget.ramp, "consolidate", "zero evidence must not default to stretch");
		assert.equal(budget.syntaxBand, "B1");
		assert.equal(budget.vocabBand, "B1");
	} finally {
		handle.close();
	}
});

test("direction NULL recall attempts are excluded from both streams", () => {
	const handle = freshDb();
	try {
		const item = insertWord(handle);
		// 3 productive forward correct; 2 legacy directionless attempts must not be bucketed.
		for (let i = 0; i < 3; i++) insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(i) });
		for (let i = 0; i < 2; i++) insertRecall(handle, { itemId: item, direction: null, verdict: "correct", completedAt: iso(100 + i) });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.recallForward.evidence, 3);
		assert.equal(profile.recallReverse.evidence, 0);
		assert.equal(profile.recallForward.rate, 1);
		// NULL evidence never feeds assistance either.
		assert.equal(profile.assistance.evidence, 3);
	} finally {
		handle.close();
	}
});

test("forward and reverse recall are bucketed by exact direction", () => {
	const handle = freshDb();
	try {
		const item = insertWord(handle);
		// forward: 4 correct + 1 incorrect -> rate 0.8
		insertRecall(handle, { itemId: item, direction: "forward", verdict: "incorrect", completedAt: iso(0) });
		for (let i = 0; i < 4; i++) insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(10 + i) });
		// reverse: 2 correct + 2 incorrect -> rate 0.5
		for (let i = 0; i < 2; i++) insertRecall(handle, { itemId: item, direction: "reverse", verdict: "correct", completedAt: iso(i) });
		for (let i = 0; i < 2; i++) insertRecall(handle, { itemId: item, direction: "reverse", verdict: "incorrect", completedAt: iso(10 + i) });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.recallForward.evidence, 5);
		assert.equal(profile.recallForward.rate, 0.8);
		assert.equal(profile.recallReverse.evidence, 4);
		assert.equal(profile.recallReverse.rate, 0.5);
	} finally {
		handle.close();
	}
});

test("sentence first-pass dedupes retries per (cycle, exercise) on the earliest row", () => {
	const handle = freshDb();
	try {
		const item = insertSentenceExercise(handle, insertWord(handle), "L3");
		const itemId = Number(handle.db.prepare("SELECT item_id FROM exercises WHERE id = ?").get(item)!.item_id);
		// Cycle A: earliest attempt is wrong+assisted, a later correct retry must NOT count.
		insertSentenceAttempt(handle, { itemId, exerciseId: item, cycleId: "A", verdict: "incorrect", assistance: "hint", startedAt: iso(0) });
		insertSentenceAttempt(handle, { itemId, exerciseId: item, cycleId: "A", verdict: "correct", assistance: "none", startedAt: iso(10) });
		// Cycle B: earliest attempt is correct+unassisted -> a first-pass success.
		insertSentenceAttempt(handle, { itemId, exerciseId: item, cycleId: "B", verdict: "correct", assistance: "none", startedAt: iso(20) });
		const profile = computeLearnerProfile(handle.db, NOW);
		// Two distinct first-pass samples; only one (B) is a success -> rate 0.5.
		assert.equal(profile.sentence.evidence, 2);
		assert.equal(profile.sentence.rate, 0.5);
		// One first-pass (A) used assistance -> assistance rate 0.5 over sentence evidence.
		assert.equal(profile.assistance.rate, 0.5);
	} finally {
		handle.close();
	}
});

test("sentence first-pass success requires correct AND unassisted (assisted-correct is not a success)", () => {
	const handle = freshDb();
	try {
		const itemId = insertWord(handle);
		const ex = insertSentenceExercise(handle, itemId, "L3");
		// Cycle A: earliest is correct+hint -> NOT a first-pass success.
		insertSentenceAttempt(handle, { itemId, exerciseId: ex, cycleId: "A", verdict: "correct", assistance: "hint", startedAt: iso(0) });
		// Cycle B: earliest is correct+none -> a first-pass success.
		insertSentenceAttempt(handle, { itemId, exerciseId: ex, cycleId: "B", verdict: "correct", assistance: "none", startedAt: iso(10) });
		const profile = computeLearnerProfile(handle.db, NOW);
		// Only one unassisted-correct first pass of two -> 0.5, not 1.0.
		assert.equal(profile.sentence.evidence, 2);
		assert.equal(profile.sentence.rate, 0.5, "assisted-correct first pass must not count as a success");
	} finally {
		handle.close();
	}
});

test("sentence stream is bounded to its 50 most recent first-pass samples", () => {
	const handle = freshDb();
	try {
		const itemId = insertWord(handle);
		const ex = insertSentenceExercise(handle, itemId, "L3");
		for (let i = 0; i < 60; i++) insertSentenceAttempt(handle, { itemId, exerciseId: ex, cycleId: `c${i}`, verdict: "correct", startedAt: iso(i), completedAt: iso(i) });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.sentence.evidence, 50, "sentence first-pass stream capped at 50");
	} finally {
		handle.close();
	}
});

test("sentence_self_report and non-evaluated rows never affect the profile", () => {
	const handle = freshDb();
	try {
		const itemId = insertWord(handle);
		const ex = insertSentenceExercise(handle, itemId, "L3");
		// One real evaluated first-pass success.
		insertSentenceAttempt(handle, { itemId, exerciseId: ex, cycleId: "real", verdict: "correct", startedAt: iso(0) });
		// A sentence_self_report row (status=self_report) on the same exercise.
		handle.db
			.prepare(
				"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, explicit_rating, started_at, completed_at) " +
					"VALUES (?, ?, ?, ?, ?, 1, 1, 'sentence_self_report', 'forward', 'none', 'self_report', 'again', ?, ?)",
			)
			.run(randomUUID(), itemId, ex, "selfrep", randomUUID(), iso(1), iso(1));
		// An evaluating (non-evaluated) row.
		handle.db
			.prepare(
				"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, started_at) " +
					"VALUES (?, ?, ?, ?, ?, 1, 1, 'sentence_production', 'forward', 'none', 'evaluating', ?)",
			)
			.run(randomUUID(), itemId, ex, "evaluating", randomUUID(), iso(2));
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.sentence.evidence, 1, "only the evaluated first pass counts");
		assert.equal(profile.sentence.rate, 1);
		assert.equal(profile.assistance.evidence, 1);
	} finally {
		handle.close();
	}
});

test("vocab band and confidence thresholds over productive forward recall", () => {
	const handle = freshDb();
	try {
		// 30 forward, 29 correct, all unassisted -> B3, high confidence.
		const item = insertWord(handle);
		insertRecall(handle, { itemId: item, direction: "forward", verdict: "incorrect", completedAt: iso(0) });
		for (let i = 0; i < 29; i++) insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(10 + i) });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.vocab.band, "B3");
		assert.equal(profile.vocab.confidence, "high");
		assert.equal(profile.vocab.evidence, 30);
	} finally {
		handle.close();
	}
});

test("vocab stays B1 below 10 forward evidence even with a high rate", () => {
	const handle = freshDb();
	try {
		const item = insertWord(handle);
		for (let i = 0; i < 9; i++) insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(i) });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.vocab.band, "B1");
		assert.equal(profile.vocab.confidence, "low");
	} finally {
		handle.close();
	}
});

test("vocab B2 at rate>=0.85 and B0 at rate<0.50", () => {
	const b2 = freshDb();
	try {
		const item = insertWord(b2);
		for (let i = 0; i < 18; i++) insertRecall(b2, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(i) });
		for (let i = 0; i < 2; i++) insertRecall(b2, { itemId: item, direction: "forward", verdict: "incorrect", completedAt: iso(100 + i) });
		assert.equal(computeLearnerProfile(b2.db, NOW).vocab.band, "B2");
	} finally {
		b2.close();
	}
	const b0 = freshDb();
	try {
		const item = insertWord(b0);
		for (let i = 0; i < 12; i++) insertRecall(b0, { itemId: item, direction: "forward", verdict: "incorrect", completedAt: iso(i) });
		assert.equal(computeLearnerProfile(b0.db, NOW).vocab.band, "B0");
	} finally {
		b0.close();
	}
});

test("syntax band: B0 on weak L2, B2 on solid L3, B3 on strong unassisted L3", () => {
	// B0: L2 evidence>=5, rate<0.50. B0 reports L2 evidence/rate/confidence (medium at 12).
	const b0 = freshDb();
	try {
		const itemId = insertWord(b0);
		const ex = insertSentenceExercise(b0, itemId, "L2");
		for (let i = 0; i < 12; i++) insertSentenceAttempt(b0, { itemId, exerciseId: ex, cycleId: `c${i}`, verdict: "incorrect", startedAt: iso(i) });
		const syntax = computeLearnerProfile(b0.db, NOW).syntax;
		assert.equal(syntax.band, "B0");
		assert.equal(syntax.evidence, 12, "B0 reports L2 evidence");
		assert.equal(syntax.rate, 0);
		assert.equal(syntax.confidence, "medium", "B0 confidence derives from reported L2 evidence");
	} finally {
		b0.close();
	}
	// B2: L3 evidence>=5, rate>=0.65 but below B3 (evidence<15). Reports L3.
	const b2 = freshDb();
	try {
		const itemId = insertWord(b2);
		const ex = insertSentenceExercise(b2, itemId, "L3");
		for (let i = 0; i < 7; i++) insertSentenceAttempt(b2, { itemId, exerciseId: ex, cycleId: `c${i}`, verdict: "correct", startedAt: iso(i) });
		for (let i = 0; i < 3; i++) insertSentenceAttempt(b2, { itemId, exerciseId: ex, cycleId: `d${i}`, verdict: "incorrect", startedAt: iso(100 + i) });
		const syntax = computeLearnerProfile(b2.db, NOW).syntax;
		assert.equal(syntax.band, "B2");
		assert.equal(syntax.evidence, 10, "B2 reports L3 evidence");
		assert.equal(syntax.confidence, "medium");
	} finally {
		b2.close();
	}
	// B3: L3 evidence>=15, rate>=0.85, sentence assistance<=0.15.
	const b3 = freshDb();
	try {
		const itemId = insertWord(b3);
		const ex = insertSentenceExercise(b3, itemId, "L3");
		for (let i = 0; i < 13; i++) insertSentenceAttempt(b3, { itemId, exerciseId: ex, cycleId: `c${i}`, verdict: "correct", startedAt: iso(i) });
		for (let i = 0; i < 2; i++) insertSentenceAttempt(b3, { itemId, exerciseId: ex, cycleId: `d${i}`, verdict: "incorrect", startedAt: iso(100 + i) });
		assert.equal(computeLearnerProfile(b3.db, NOW).syntax.band, "B3");
	} finally {
		b3.close();
	}
});

test("error tags: distinct-item counting, ranked count-desc then tag-asc, count>=2, max 3", () => {
	const handle = freshDb();
	try {
		// Same item repeating a tag counts ONCE (no retry amplification): all of
		// this item's tags stay at distinct-count 1 and fall below the threshold.
		const one = insertWord(handle);
		insertRecall(handle, { itemId: one, direction: "forward", verdict: "partial", errorTags: ["grammar", "collocation"], completedAt: iso(0) });
		insertRecall(handle, { itemId: one, direction: "forward", verdict: "partial", errorTags: ["grammar"], completedAt: iso(1) });
		insertRecall(handle, { itemId: one, direction: "forward", verdict: "partial", errorTags: ["grammar", "collocation", "spelling"], completedAt: iso(2) });
		assert.deepEqual(computeLearnerProfile(handle.db, NOW).errorFocus, []);
		// Distinct items raise the count: grammar 4 items > collocation 3 > word_order 2.
		for (let i = 0; i < 3; i++) {
			const it = insertWord(handle);
			insertRecall(handle, { itemId: it, direction: "forward", verdict: "partial", errorTags: ["grammar", "collocation"], completedAt: iso(10 + i) });
		}
		const itG = insertWord(handle);
		insertRecall(handle, { itemId: itG, direction: "forward", verdict: "partial", errorTags: ["grammar"], completedAt: iso(13) });
		for (let i = 0; i < 2; i++) {
			const it = insertWord(handle);
			insertRecall(handle, { itemId: it, direction: "forward", verdict: "partial", errorTags: ["word_order"], completedAt: iso(20 + i) });
		}
		// Malformed JSON is ignored, not fatal.
		handle.db
			.prepare(
				"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, verdict, error_tags_json, started_at, completed_at) " +
					"VALUES (?, ?, NULL, ?, ?, 1, 1, 'recall', 'forward', 'none', 'evaluated', 'partial', 'not-json', ?, ?)",
			)
			.run(randomUUID(), one, randomUUID(), randomUUID(), iso(30), iso(30));
		const { errorFocus } = computeLearnerProfile(handle.db, NOW);
		// Distinct items: grammar = one + 3 + itG = 5, collocation = one + 3 = 4, word_order = 2.
		assert.deepEqual(errorFocus.map((t) => `${t.tag}:${t.count}`), ["grammar:5", "collocation:4", "word_order:2"]);
	} finally {
		handle.close();
	}
});

test("assistance rate counts only non-none assistance over selected evidence", () => {
	const handle = freshDb();
	try {
		const item = insertWord(handle);
		insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", assistance: "none", completedAt: iso(0) });
		insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", assistance: "hint", completedAt: iso(1) });
		insertRecall(handle, { itemId: item, direction: "reverse", verdict: "correct", assistance: "revealed", completedAt: iso(2) });
		const profile = computeLearnerProfile(handle.db, NOW);
		// 2 of 3 selected attempts used assistance (hint + revealed).
		assert.equal(profile.assistance.evidence, 3);
		assert.equal(profile.assistance.rate, 2 / 3);
	} finally {
		handle.close();
	}
});

test("each analytic stream is bounded to its 50 most recent samples", () => {
	const handle = freshDb();
	try {
		const item = insertWord(handle);
		for (let i = 0; i < 60; i++) insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(i) });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.recallForward.evidence, 50);
	} finally {
		handle.close();
	}
});

test("out-of-window attempts are excluded by the 60-day rolling window", () => {
	const handle = freshDb();
	try {
		const item = insertWord(handle);
		insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: iso(0) });
		// 90 days ago -> outside the 60-day window.
		insertRecall(handle, { itemId: item, direction: "forward", verdict: "correct", completedAt: new Date(NOW.getTime() - 90 * 86400000).toISOString() });
		const profile = computeLearnerProfile(handle.db, NOW);
		assert.equal(profile.recallForward.evidence, 1);
	} finally {
		handle.close();
	}
});

test("ramp consolidates on low sentence first-pass or high assistance, else stretches", () => {
	// Low sentence first-pass (<0.60) -> consolidate.
	const lowSentence = freshDb();
	try {
		const itemId = insertWord(lowSentence);
		const ex = insertSentenceExercise(lowSentence, itemId, "L3");
		for (let i = 0; i < 5; i++) insertSentenceAttempt(lowSentence, { itemId, exerciseId: ex, cycleId: `c${i}`, verdict: "incorrect", startedAt: iso(i) });
		for (let i = 0; i < 5; i++) insertSentenceAttempt(lowSentence, { itemId, exerciseId: ex, cycleId: `d${i}`, verdict: "correct", startedAt: iso(100 + i) });
		assert.equal(deriveBudget(computeLearnerProfile(lowSentence.db, NOW)).ramp, "consolidate");
	} finally {
		lowSentence.close();
	}
	// High assistance (>0.35) -> consolidate.
	const highAssist = freshDb();
	try {
		const item = insertWord(highAssist);
		for (let i = 0; i < 10; i++) insertRecall(highAssist, { itemId: item, direction: "forward", verdict: "correct", assistance: "hint", completedAt: iso(i) });
		assert.equal(deriveBudget(computeLearnerProfile(highAssist.db, NOW)).ramp, "consolidate");
	} finally {
		highAssist.close();
	}
});

test("budget mapping by band and vocabulary wording uses the vocab band", () => {
	const profile = coldStartProfile();
	// B0 syntax / B0 vocab
	profile.syntax.band = "B0"; profile.vocab.band = "B0";
	let b = deriveBudget(profile);
	assert.deepEqual(b.wordRange, [8, 12]);
	assert.equal(b.maxKeyWords, 1);
	assert.match(b.vocabulary, /A2/);
	// B2 syntax, B3 vocab: vocabulary wording must reflect the vocab band (C1), not syntax.
	profile.syntax.band = "B2"; profile.vocab.band = "B3";
	b = deriveBudget(profile);
	assert.deepEqual(b.wordRange, [15, 22]);
	assert.equal(b.maxKeyWords, 2);
	assert.match(b.vocabulary, /C1/);
	// B3 syntax
	profile.syntax.band = "B3";
	b = deriveBudget(profile);
	assert.deepEqual(b.wordRange, [18, 28]);
	assert.equal(b.maxKeyWords, 3);
});

// -- LLM-coupled coverage (fake transport; deterministic, no network) -----

const FAKE_CTX = {} as ExtensionContext;
const FAKE_CONFIG = { maxTokens: 900, thinkingLevel: "off" } as unknown as PetConfig;

test("generation prompt receives the concise profile + budget block", async () => {
	let captured = "";
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => { captured = request.prompt; return JSON.stringify({ ready: false, reason: "test" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	await generateLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "a real conversation with english", [], FAKE_CONFIG, undefined, adaptive);
	assert.match(captured, /learner_profile/);
	assert.match(captured, /difficulty_budget/);
	assert.match(captured, /12-18/); // B1 word range reaches the prompt
	assert.match(captured, /句法：B1/);
	// No hardcoded "中级学习者" assumption leaks into the prompt.
	assert.doesNotMatch(captured, /中级学习者/);
});

test("deterministic critic gate rejects an out-of-budget sentence without consulting the LLM", async () => {
	let calls = 0;
	const llm = {
		complete: async () => { calls++; return ""; },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	// Cold-start B1 budget is [12,18]; this 7-word sentence is out of range.
	const tooShort: GeneratedItem = {
		type: "sentence", text: "This is a short tiny test line.", meaning: "短句",
		levels: ["This is.", "This is a short.", "This is a short tiny test line."],
		levels_cn: ["x", "y", "短句"], chunks: ["This is", "a short"], keyWords: [{ text: "short", meaning: "短" }],
	};
	const verdict = await critiqueLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, { topic: "t", items: [tooShort] }, [], FAKE_CONFIG, adaptive);
	assert.equal(verdict.available, true);
	assert.equal(verdict.pass, false);
	assert.ok(verdict.issues.some((i) => i.severity === "blocker" && i.category === "budget"), "budget blocker raised");
	assert.equal(calls, 0, "deterministic gate must not call the LLM");
});

test("deterministic critic gate rejects too many keyWords", async () => {
	let calls = 0;
	const llm = { complete: async () => { calls++; return ""; }, dispose: async () => {} } as unknown as PiSdkLlmClient;
	// Force a B0 budget (maxKeyWords=1) but supply 2 keyWords.
	const profile = coldStartProfile();
	profile.syntax.band = "B0";
	const adaptive: AdaptiveContext = { profile, budget: deriveBudget(profile) };
	const sentence: GeneratedItem = {
		type: "sentence", text: "The quick brown fox jumps over the lazy dog now.", meaning: "句",
		levels: ["The fox.", "The fox jumps.", "The quick brown fox jumps over the lazy dog now."],
		levels_cn: ["x", "y", "句"], chunks: ["a", "b"],
		keyWords: [{ text: "fox", meaning: "狐" }, { text: "lazy", meaning: "懒" }],
	};
	const verdict = await critiqueLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, { topic: "t", items: [sentence] }, [], FAKE_CONFIG, adaptive);
	assert.equal(verdict.pass, false);
	assert.ok(verdict.issues.some((i) => i.category === "budget" && /生词/.test(i.description)));
	assert.equal(calls, 0);
});

test("in-budget sentence passes the deterministic gate and may reach the LLM critic", async () => {
	let calls = 0;
	const llm = {
		complete: async () => { calls++; return JSON.stringify({ pass: true, issues: [], summary: "ok" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	// 12 words, within B1 [12,18]; 2 keyWords (<=2).
	const sentence: GeneratedItem = {
		type: "sentence",
		text: "Because several sessions share one database each action commits before widgets refresh.",
		meaning: "句",
		levels: ["Each action commits.", "Each action commits before widgets refresh.", "Because several sessions share one database each action commits before widgets refresh."],
		levels_cn: ["x", "y", "句"], chunks: ["a", "b"],
		keyWords: [{ text: "commit", meaning: "提交" }, { text: "refresh", meaning: "刷新" }],
	};
	const verdict = await critiqueLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, { topic: "t", items: [sentence] }, [], FAKE_CONFIG, adaptive);
	assert.equal(verdict.pass, true);
	assert.equal(calls, 1, "LLM critic reached because the deterministic gate passed");
});

test("generateLesson accepts a valid 9-word B0 cloze lesson (lower budget min)", async () => {
	// Under a B0 budget (word range [8,12]), a valid 9-word cloze sentence must be
	// accepted ready=true with exactly one blank.
	let calls = 0;
	let captured = "";
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			calls++;
			captured = request.prompt;
			return JSON.stringify({
				ready: true, topic: "b0-lesson",
				items: [
					{ type: "word", text: "fox", meaning: "狐", example: "The fox runs.", example_cn: "狐在跑。" },
					{ type: "phrase", text: "lazy dog", meaning: "懒狗", example: "The lazy dog sleeps.", example_cn: "懒狗在睡。" },
					{
					type: "cloze", text: "The brown fox ___ (jump) over the lazy dog now.", meaning: "jumps",
					example: "The brown fox jumps over the lazy dog now.", example_cn: "那只棕狐现在跳过了懒狗。（考点：第三人称单数）",
					},
				],
			});
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const profile = coldStartProfile();
	profile.syntax.band = "B0";
	const adaptive: AdaptiveContext = { profile, budget: deriveBudget(profile) };
	const decision = await generateLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "a conversation about a fox", [], FAKE_CONFIG, undefined, adaptive);
	assert.equal(decision.ready, true, "9-word B0 cloze passes the budget min");
	assert.equal(calls, 1, "single generation call for a complete valid cloze");
	assert.match(captured, /8-12/, "B0 word range reaches the generation prompt");
});

test("generateReplacement prompt injects the profile + budget block", async () => {
	let captured = "";
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => { captured = request.prompt; return JSON.stringify({ ready: false, reason: "test" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const skipped = { type: "word", text: "known", meaning: "熟词" } as unknown as import("../db.ts").ItemRow;
	await generateReplacement(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "conversation", [], FAKE_CONFIG, skipped, adaptive);
	assert.match(captured, /learner_profile/);
	assert.match(captured, /difficulty_budget/);
	assert.match(captured, /12-18/, "B1 budget word range reaches the replacement prompt");
	assert.doesNotMatch(captured, /中级学习者/);
});

// -- Attempt question-snapshot log (备课依据) -------------------------------

test("evaluated attempts persist the question snapshot and feed the lesson-prep block", () => {
	const handle = freshDb();
	try {
		const itemId = insertWord(handle, "reload");
		const attempt: PendingAttempt = {
			itemId,
			version: 315,
			direction: "reverse",
			sessionGeneration: 1,
			answerText: "重新加载",
			assistanceLevel: "none",
			startedAt: iso(),
			verdict: "incorrect",
			feedback: "只写了“重新加载”，漏写了目标中的“使新改动生效”。",
			questionText: "写出单词「reload」的中文释义",
		};
		insertEvaluatedAttempt(handle.db, attempt, "again", NOW);
		const log = recentAttemptLog(handle.db);
		assert.equal(log.length, 1);
		assert.equal(log[0].question, "写出单词「reload」的中文释义");
		assert.equal(log[0].answer, "重新加载");
		assert.equal(log[0].verdict, "incorrect");
		assert.equal(log[0].direction, "reverse");
		assert.match(log[0].feedback, /使新改动生效/);
		const block = formatAttemptLogBlock(log);
		assert.match(block, /英→中回忆/);
		assert.match(block, /题:写出单词「reload」的中文释义/);
		assert.match(block, /答:重新加载/);
		assert.match(block, /判:错/);
		assert.match(block, /反馈:/);
	} finally {
		handle.close();
	}
});

test("attempt log excludes non-evaluated rows, orders newest first, tolerates legacy NULL snapshot", () => {
	const handle = freshDb();
	try {
		const itemId = insertWord(handle);
		insertRecall(handle, { itemId, direction: "forward", verdict: "correct", completedAt: iso(1000) });
		insertRecall(handle, { itemId, direction: "reverse", verdict: "incorrect", completedAt: iso(2000) });
		// In-flight row without a verdict must not leak into the log.
		handle.db.prepare(
			"INSERT INTO attempts (id, item_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, assistance_level, status, started_at) VALUES (?, ?, ?, ?, 1, 1, 'recall', 'none', 'evaluating', ?)",
		).run(randomUUID(), itemId, randomUUID(), randomUUID(), iso(3000));
		const log = recentAttemptLog(handle.db);
		assert.equal(log.length, 2);
		assert.equal(log[0].verdict, "incorrect");
		assert.equal(log[1].verdict, "correct");
		assert.equal(log[0].question, null);
		assert.match(formatAttemptLogBlock(log), /（空）/);
	} finally {
		handle.close();
	}
});

test("generateLesson prompt carries the recent attempt log and the minimal-meaning rule", async () => {
	let captured = "";
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => { captured = request.prompt; return JSON.stringify({ ready: false, reason: "test" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const recentLog = "- [英→中回忆] 题:写出单词「reload」的中文释义 | 答:重新加载 | 判:错 | 反馈:漏写补充说明";
	await generateLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "a real conversation with english", [], FAKE_CONFIG, undefined, adaptive, recentLog);
	assert.match(captured, /最近出题与作答记录/);
	assert.match(captured, /写出单词「reload」的中文释义/);
	assert.match(captured, /最小中文释义/);
});

test("generateReplacement prompt carries the recent attempt log and the minimal-meaning rule", async () => {
	let captured = "";
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => { captured = request.prompt; return JSON.stringify({ ready: false, reason: "test" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const skipped = { type: "word", text: "reload", meaning: "重新加载" } as unknown as import("../db.ts").ItemRow;
	await generateReplacement(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "conversation", [], FAKE_CONFIG, skipped, adaptive, "- [英→中回忆] 题:x | 答:y | 判:对");
	assert.match(captured, /最近出题与作答记录/);
	assert.match(captured, /最小中文释义/);
});

test("critic prompt includes the minimal-meaning blocker rule", async () => {
	let captured = "";
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => { captured = request.prompt; return JSON.stringify({ pass: true, issues: [], summary: "ok" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const adaptive: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	// A word item skips the sentence-only deterministic gate and reaches the LLM call.
	const word: GeneratedItem = { type: "word", text: "reload", meaning: "重新加载", example: "Reload the extension.", example_cn: "重新加载扩展。" };
	const verdict = await critiqueLesson(llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false }, { topic: "t", items: [word] }, [], FAKE_CONFIG, adaptive);
	assert.equal(verdict.pass, true);
	assert.match(captured, /最小释义/);
});

test("answer-evaluation rubric is direction-aware: reverse accepts synonyms, forward stays strict", async () => {
	const captured: string[] = [];
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => { captured.push(request.prompt); return JSON.stringify({ verdict: "correct", feedback: "" }); },
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const item = { text: "filled", meaning: "（订单）已成交的" } as unknown as import("../db.ts").ItemRow;
	const resolved = { provider: "p", model: "m" };
	await evaluateAttempt(llm, FAKE_CTX, item, "已经成交的", resolved, "reverse");
	await evaluateAttempt(llm, FAKE_CTX, item, "filled", resolved, "forward");
	assert.match(captured[0], /同义表达/);
	assert.match(captured[0], /语体差异/);
	assert.match(captured[0], /生效，起作用/);
	assert.match(captured[0], /不同义项/);
	assert.doesNotMatch(captured[0], /完全一致/);
	assert.match(captured[1], /完全一致/);
	assert.doesNotMatch(captured[1], /语体差异/);
});

// -- Generation decision ring log (备课决策日志) ----------------------------

test("gen log appends in order and caps at 20 entries", () => {
	const handle = freshDb();
	try {
		for (let i = 0; i < 25; i++) appendGenLog(handle.db, `status-${i}`);
		const log = getGenLog(handle.db);
		assert.equal(log.length, 20);
		assert.equal(log[0].s, "status-5"); // oldest 5 dropped
		assert.equal(log[19].s, "status-24");
		assert.ok(log.every((e) => typeof e.t === "string" && e.t.length > 0));
	} finally {
		handle.close();
	}
});

test("gen log survives corrupt JSON and overlong status", () => {
	const handle = freshDb();
	try {
		setStat(handle.db, "gen_log", "not-json");
		assert.deepEqual(getGenLog(handle.db), []);
		appendGenLog(handle.db, "x".repeat(500));
		const log = getGenLog(handle.db);
		assert.equal(log.length, 1);
		assert.equal(log[0].s.length, 200);
	} finally {
		handle.close();
	}
});

// -- P0-3: conservative ramp + smoothing hysteresis ------------------------

test("ramp stretches only with sufficient unassisted sentence evidence", () => {
	const handle = freshDb();
	try {
		const itemId = insertWord(handle);
		const ex = insertSentenceExercise(handle, itemId, "L3");
		// 8/10 first-pass correct, unassisted -> stretch allowed.
		for (let i = 0; i < 8; i++) insertSentenceAttempt(handle, { itemId, exerciseId: ex, cycleId: `ok${i}`, verdict: "correct", startedAt: iso(i) });
		for (let i = 0; i < 2; i++) insertSentenceAttempt(handle, { itemId, exerciseId: ex, cycleId: `no${i}`, verdict: "incorrect", startedAt: iso(100 + i) });
		assert.equal(deriveBudget(computeLearnerProfile(handle.db, NOW)).ramp, "stretch");
	} finally {
		handle.close();
	}
	// Same rates but too little evidence (4 samples) -> conservative.
	const thin = freshDb();
	try {
		const itemId = insertWord(thin);
		const ex = insertSentenceExercise(thin, itemId, "L3");
		for (let i = 0; i < 4; i++) insertSentenceAttempt(thin, { itemId, exerciseId: ex, cycleId: `t${i}`, verdict: "correct", startedAt: iso(i) });
		assert.equal(deriveBudget(computeLearnerProfile(thin.db, NOW)).ramp, "consolidate");
	} finally {
		thin.close();
	}
});

test("smoothBudget: promotion steps one band at a time, demotion is immediate", async () => {
	const { smoothBudget } = await import("../learner-profile.ts");
	const handle = freshDb();
	try {
		const base = deriveBudget(coldStartProfile()); // B1/B1 consolidate
		// First call persists the snapshot unchanged.
		const first = smoothBudget(handle.db, base);
		assert.equal(first.syntaxBand, "B1");
		assert.equal(first.ramp, "consolidate");
		// Jump demand to B3: smoothed to a single step up (B2).
		const hot = { ...base, syntaxBand: "B3" as const, vocabBand: "B3" as const };
		const up1 = smoothBudget(handle.db, hot);
		assert.equal(up1.syntaxBand, "B2");
		assert.equal(up1.vocabBand, "B2");
		assert.deepEqual(up1.wordRange, [15, 22], "derived fields follow the smoothed band");
		const up2 = smoothBudget(handle.db, hot);
		assert.equal(up2.syntaxBand, "B3");
		// Collapse demand to B0: demotion applies immediately (no hysteresis on the way down).
		const cold = { ...base, syntaxBand: "B0" as const };
		const down = smoothBudget(handle.db, cold);
		assert.equal(down.syntaxBand, "B0");
	} finally {
		handle.close();
	}
});

test("smoothBudget: stretch requires two consecutive stretch signals", async () => {
	const { smoothBudget } = await import("../learner-profile.ts");
	const handle = freshDb();
	try {
		const base = deriveBudget(coldStartProfile());
		const stretchy = { ...base, ramp: "stretch" as const };
		assert.equal(smoothBudget(handle.db, stretchy).ramp, "consolidate", "first stretch signal is debounced");
		assert.equal(smoothBudget(handle.db, stretchy).ramp, "stretch", "second consecutive signal engages stretch");
		// A consolidate signal resets the streak.
		assert.equal(smoothBudget(handle.db, { ...base, ramp: "consolidate" as const }).ramp, "consolidate");
		assert.equal(smoothBudget(handle.db, stretchy).ramp, "consolidate", "streak reset after consolidation");
	} finally {
		handle.close();
	}
});

// -- P1: errorTag whitelist + distinct-counting ----------------------------

test("error tags are normalized to a whitelist and counted per distinct item", () => {
	const handle = freshDb();
	try {
		const itemA = insertWord(handle);
		const itemB = insertWord(handle);
		// Same item, three consecutive retries with the same underlying tag in
		// different spellings: must normalize and count ONCE (distinct item).
		insertRecall(handle, { itemId: itemA, direction: "forward", verdict: "incorrect", errorTags: ["Spelling"], completedAt: iso(1) });
		insertRecall(handle, { itemId: itemA, direction: "forward", verdict: "incorrect", errorTags: ["typo"], completedAt: iso(2) });
		insertRecall(handle, { itemId: itemA, direction: "forward", verdict: "incorrect", errorTags: ["拼写"], completedAt: iso(3) });
		// A second item with the same tag raises the distinct count to 2.
		insertRecall(handle, { itemId: itemB, direction: "forward", verdict: "incorrect", errorTags: ["spelling"], completedAt: iso(4) });
		// Unknown tags collapse to "other" (two distinct items here to pass the >=2 threshold).
		insertRecall(handle, { itemId: itemB, direction: "forward", verdict: "incorrect", errorTags: ["some-novel-tag"], completedAt: iso(5) });
		insertRecall(handle, { itemId: itemA, direction: "forward", verdict: "incorrect", errorTags: ["another-strange-one"], completedAt: iso(6) });
		const profile = computeLearnerProfile(handle.db, NOW);
		const focus = Object.fromEntries(profile.errorFocus.map((t) => [t.tag, t.count]));
		assert.equal(focus.spelling, 2, "distinct items, not raw occurrences (itemA x3 retries count once)");
		assert.equal(focus.other, 2);
		assert.ok(!("Spelling" in focus) && !("typo" in focus), "no un-normalized tags survive");
	} finally {
		handle.close();
	}
});
