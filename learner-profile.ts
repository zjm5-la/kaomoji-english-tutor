import type { DatabaseSync } from "node:sqlite";

// -- Learner profile & difficulty budget (P2) -----------------------------
//
// Deterministic SQLite aggregation of past answers into a multi-dimensional
// learner profile, plus a pure derivation of an objective difficulty budget.
// No cache and no new persistence: recompute per generation/stats call.
//
// Design contract (see docs/learner-level-framework.md):
// - Evidence = attempts with status='evaluated' and a real verdict, excluding
//   sentence_self_report. A 60-day rolling window applies; each analytic
//   stream is bounded to its 50 most recent samples.
// - Direction is exact: forward = Chinese -> English productive recall,
//   reverse = English -> Chinese recognition. Legacy NULL direction is missing
//   evidence and is never bucketed or defaulted.
// - Sentence first-pass = earliest evaluated row per (review_cycle_id,
//   exercise_id); success requires verdict='correct' AND assistance='none'.
//   Stage comes from exercises.stage; mutable items.progress and the inert
//   mastery_state evidence/error columns are never used.

export type Band = "B0" | "B1" | "B2" | "B3";
export type Ramp = "consolidate" | "stretch";
export type Confidence = "low" | "medium" | "high";

export interface DimensionRate {
	/** Number of bounded first-pass samples backing this rate. */
	evidence: number;
	/** Correct fraction, or null when there is no evidence. */
	rate: number | null;
}

export interface BandDimension extends DimensionRate {
	band: Band;
	confidence: Confidence;
}

export interface ErrorFocusTag {
	tag: string;
	count: number;
}

export interface AssistanceRate {
	rate: number | null;
	evidence: number;
}

export interface LearnerProfile {
	/** Syntax band is driven by L2/L3 sentence first-pass + sentence assistance. */
	syntax: BandDimension;
	/** Vocab band is driven by productive forward recall + forward assistance. */
	vocab: BandDimension;
	errorFocus: ErrorFocusTag[];
	assistance: AssistanceRate;
	/** Overall sentence first-pass rate across all reached stages. */
	sentence: DimensionRate;
	recallForward: DimensionRate;
	recallReverse: DimensionRate;
	windowDays: number;
}

export interface AdaptiveContext {
	profile: LearnerProfile;
	budget: DifficultyBudget;
}

export interface DifficultyBudget {
	syntaxBand: Band;
	vocabBand: Band;
	/** Sentence word-count range, inclusive. */
	wordRange: [number, number];
	maxKeyWords: number;
	/** Clause-structure guidance (derived from the syntax band). */
	structure: string;
	/** Vocabulary-level wording (derived from the vocab band). */
	vocabulary: string;
	ramp: Ramp;
	errorFocus: ErrorFocusTag[];
}

export const PROFILE_WINDOW_DAYS = 60;
const STREAM_BOUND = 50;

const WORD_RANGE_BY_BAND: Record<Band, [number, number]> = {
	B0: [8, 12],
	B1: [12, 18],
	B2: [15, 22],
	B3: [18, 28],
};

const MAX_KEY_WORDS_BY_BAND: Record<Band, number> = {
	B0: 1,
	B1: 2,
	B2: 2,
	B3: 3,
};

const STRUCTURE_BY_BAND: Record<Band, string> = {
	B0: "只用简单句，不加从句、不嵌套，以主干为主",
	B1: "最多一个从句（定语/状语/宾语从句），不嵌套",
	B2: "可用一个复合结构（定语从句/状语从句/分词短语），不要多层嵌套",
	B3: "可自然使用并列结构与嵌套从句",
};

const VOCAB_LEVEL_BY_BAND: Record<Band, string> = {
	B0: "A2 高频常用词",
	B1: "B1 常用词",
	B2: "B2 中高级词",
	B3: "C1 高级词",
};

interface StreamAggregate {
	/** Total bounded samples in this stream. */
	evidence: number;
	/** verdict='correct' — numerator for recall rates. */
	correct: number;
	/** verdict='correct' AND assistance='none' — numerator for sentence first-pass success. */
	firstPassSuccess: number;
	/** assistance_level != 'none'. */
	assisted: number;
	errorTags: Map<string, number>;
}

function emptyStream(): StreamAggregate {
	return { evidence: 0, correct: 0, firstPassSuccess: 0, assisted: 0, errorTags: new Map() };
}

function pushAttempt(stream: StreamAggregate, row: RawEvaluated): void {
	stream.evidence++;
	if (row.verdict === "correct") stream.correct++;
	if (row.verdict === "correct" && row.assistance_level === "none") stream.firstPassSuccess++;
	if (row.assistance_level !== "none") stream.assisted++;
	addErrorTags(stream.errorTags, row.error_tags_json);
}

function addErrorTags(map: Map<string, number>, raw: string | null): void {
	if (!raw) return;
	let tags: unknown;
	try {
		tags = JSON.parse(raw);
	} catch {
		return; // fail-soft: malformed JSON is ignored, not fatal
	}
	if (!Array.isArray(tags)) return;
	for (const tag of tags) {
		if (typeof tag === "string" && tag.trim()) {
			const key = tag.trim();
			map.set(key, (map.get(key) ?? 0) + 1);
		}
	}
}

/** Recall rate: verdict='correct' fraction. */
function rateOf(stream: StreamAggregate): number | null {
	return stream.evidence > 0 ? stream.correct / stream.evidence : null;
}

/** Sentence first-pass success rate: correct AND unassisted fraction. */
function firstPassRateOf(stream: StreamAggregate): number | null {
	return stream.evidence > 0 ? stream.firstPassSuccess / stream.evidence : null;
}

function assistedRateOf(stream: StreamAggregate): number | null {
	return stream.evidence > 0 ? stream.assisted / stream.evidence : null;
}

function confidenceFromEvidence(evidence: number): Confidence {
	if (evidence < 10) return "low";
	if (evidence < 30) return "medium";
	return "high";
}

interface RawEvaluated {
	verdict: string | null;
	assistance_level: string;
	error_tags_json: string | null;
}

interface SentenceAttempt extends RawEvaluated {
	review_cycle_id: string;
	exercise_id: number;
	stage: string;
	started_at: string;
	completed_at: string | null;
	rowid: number;
}

/** A profile for a learner with no usable evidence (cold start). */
export function coldStartProfile(): LearnerProfile {
	const zero: DimensionRate = { evidence: 0, rate: null };
	const band: BandDimension = { band: "B1", confidence: "low", evidence: 0, rate: null };
	return {
		syntax: { ...band },
		vocab: { ...band },
		errorFocus: [],
		assistance: { rate: null, evidence: 0 },
		sentence: { ...zero },
		recallForward: { ...zero },
		recallReverse: { ...zero },
		windowDays: PROFILE_WINDOW_DAYS,
	};
}

/**
 * Aggregate recent evaluated attempts into a deterministic learner profile.
 * Recomputed on every call; the caller owns the lifecycle.
 */
export function computeLearnerProfile(db: DatabaseSync, now: Date = new Date()): LearnerProfile {
	const cutoff = new Date(now.getTime() - PROFILE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

	// Recall streams (kind='recall'): productive forward / recognition reverse.
	const forward = aggregateRecall(db, "forward", cutoff);
	const reverse = aggregateRecall(db, "reverse", cutoff);

	// Sentence first-pass: earliest evaluated attempt per (cycle, exercise),
	// joined to exercises.stage. Bound the deduped first-pass rows to 50 recent.
	const firstPass = aggregateSentenceFirstPass(db, cutoff);
	const sentenceAll = firstPass.all;
	const byStage = firstPass.byStage;
	const l2 = byStage.get("L2") ?? emptyStream();
	const l3 = byStage.get("L3") ?? emptyStream();

	// Combined "selected evaluated evidence" for assistance + error focus.
	const combined = emptyStream();
	mergeStream(combined, forward);
	mergeStream(combined, reverse);
	mergeStream(combined, sentenceAll);

	const forwardAssist = assistedRateOf(forward);
	const sentenceAssist = assistedRateOf(sentenceAll);

	const syntax = deriveSyntaxBand(l2, l3, sentenceAssist);
	const vocab = deriveVocabBand(forward, forwardAssist);
	const errorFocus = topErrorFocus(combined.errorTags);

	return {
		syntax,
		vocab,
		errorFocus,
		assistance: { rate: assistedRateOf(combined), evidence: combined.evidence },
		sentence: { evidence: sentenceAll.evidence, rate: firstPassRateOf(sentenceAll) },
		recallForward: { evidence: forward.evidence, rate: rateOf(forward) },
		recallReverse: { evidence: reverse.evidence, rate: rateOf(reverse) },
		windowDays: PROFILE_WINDOW_DAYS,
	};
}

function mergeStream(into: StreamAggregate, from: StreamAggregate): void {
	into.evidence += from.evidence;
	into.correct += from.correct;
	into.assisted += from.assisted;
	for (const [tag, count] of from.errorTags) into.errorTags.set(tag, (into.errorTags.get(tag) ?? 0) + count);
}

function aggregateRecall(db: DatabaseSync, direction: "forward" | "reverse", cutoff: string): StreamAggregate {
	const rows = db
		.prepare(
			"SELECT verdict, assistance_level, error_tags_json, rowid FROM attempts " +
				"WHERE status = 'evaluated' AND verdict IN ('correct','partial','incorrect') " +
				"AND kind = 'recall' AND direction = ? AND completed_at IS NOT NULL AND completed_at >= ? " +
				"ORDER BY completed_at DESC, rowid DESC LIMIT " + STREAM_BOUND,
		)
		.all(direction, cutoff) as unknown as RawEvaluated[];
	const stream = emptyStream();
	for (const row of rows) {
		pushAttempt(stream, { verdict: row.verdict, assistance_level: row.assistance_level ?? "none", error_tags_json: row.error_tags_json });
	}
	return stream;
}

function aggregateSentenceFirstPass(db: DatabaseSync, cutoff: string): { all: StreamAggregate; byStage: Map<string, StreamAggregate> } {
	const rows = db
		.prepare(
			"SELECT a.rowid AS rowid, a.review_cycle_id, a.exercise_id, a.verdict, a.assistance_level, " +
				"a.error_tags_json, a.started_at, a.completed_at, e.stage AS stage " +
				"FROM attempts a JOIN exercises e ON e.id = a.exercise_id " +
				"WHERE a.status = 'evaluated' AND a.verdict IN ('correct','partial','incorrect') " +
				"AND a.kind IN ('sentence_cloze','sentence_production') " +
				"AND a.completed_at IS NOT NULL AND a.completed_at >= ? " +
				"ORDER BY a.started_at ASC, a.rowid ASC",
		)
		.all(cutoff) as unknown as SentenceAttempt[];

	// Earliest evaluated row per (review_cycle_id, exercise_id) = first pass.
	const firstByKey = new Map<string, SentenceAttempt>();
	for (const row of rows) {
		const key = `${row.review_cycle_id}\u0000${row.exercise_id}`;
		if (!firstByKey.has(key)) firstByKey.set(key, row);
	}
	// Bound to the STREAM_BOUND most recent first-pass rows (by completion time,
	// then rowid for deterministic tie-breaking).
	const bounded = [...firstByKey.values()]
		.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "") || b.rowid - a.rowid)
		.slice(0, STREAM_BOUND);

	const all = emptyStream();
	const byStage = new Map<string, StreamAggregate>();
	for (const row of bounded) {
		pushAttempt(all, row);
		const stage = byStage.get(row.stage) ?? emptyStream();
		pushAttempt(stage, row);
		byStage.set(row.stage, stage);
	}
	return { all, byStage };
}

/** Syntax band: deterministic prior B1 with L2/L3 escalation and L2 demotion. */
function deriveSyntaxBand(l2: StreamAggregate, l3: StreamAggregate, sentenceAssist: number | null): BandDimension {
	const l2Rate = firstPassRateOf(l2);
	const l3Rate = firstPassRateOf(l3);
	let band: Band = "B1";
	// B0: struggle at the expanded-sentence stage.
	if (l2.evidence >= 5 && l2Rate !== null && l2Rate < 0.5) {
		band = "B0";
	}
	// B3 (checked before B2): reliable full-sentence production, unassisted.
	else if (l3.evidence >= 15 && l3Rate !== null && l3Rate >= 0.85 && sentenceAssist !== null && sentenceAssist <= 0.15) {
		band = "B3";
	}
	// B2: solid full-sentence production.
	else if (l3.evidence >= 5 && l3Rate !== null && l3Rate >= 0.65) {
		band = "B2";
	}
	// Report evidence/rate/confidence from the band's driving stage: L2 for B0,
	// otherwise L3 when any L3 evidence exists, falling back to L2 only then.
	const reportL2 = band === "B0" || l3.evidence === 0;
	const stream = reportL2 ? l2 : l3;
	return {
		band,
		confidence: confidenceFromEvidence(stream.evidence),
		evidence: stream.evidence,
		rate: reportL2 ? l2Rate : l3Rate,
	};
}

/** Vocab band: deterministic prior B1 driven by productive forward recall. */
function deriveVocabBand(forward: StreamAggregate, forwardAssist: number | null): BandDimension {
	const rate = rateOf(forward);
	let band: Band = "B1";
	if (forward.evidence >= 10) {
		if (forward.evidence >= 30 && rate !== null && rate >= 0.95 && forwardAssist !== null && forwardAssist <= 0.1) {
			band = "B3";
		} else if (rate !== null && rate >= 0.85) {
			band = "B2";
		} else if (rate !== null && rate < 0.5) {
			band = "B0";
		}
	}
	return { band, confidence: confidenceFromEvidence(forward.evidence), evidence: forward.evidence, rate };
}

function topErrorFocus(tags: Map<string, number>): ErrorFocusTag[] {
	return [...tags.entries()]
		.filter(([, count]) => count >= 2)
		.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
		.slice(0, 3)
		.map(([tag, count]) => ({ tag, count }));
}

/** Pure derivation of the objective difficulty budget from a profile. */
export function deriveBudget(profile: LearnerProfile): DifficultyBudget {
	const syntaxBand = profile.syntax.band;
	const vocabBand = profile.vocab.band;
	const wordRange = WORD_RANGE_BY_BAND[syntaxBand];
	const maxKeyWords = MAX_KEY_WORDS_BY_BAND[syntaxBand];
	const sentenceRate = profile.sentence.rate;
	const assist = profile.assistance.rate;
	let ramp: Ramp = "stretch";
	if (sentenceRate !== null && sentenceRate < 0.6) ramp = "consolidate";
	else if (assist !== null && assist > 0.35) ramp = "consolidate";
	return {
		syntaxBand,
		vocabBand,
		wordRange,
		maxKeyWords,
		structure: STRUCTURE_BY_BAND[syntaxBand],
		vocabulary: VOCAB_LEVEL_BY_BAND[vocabBand],
		ramp,
		errorFocus: profile.errorFocus,
	};
}

// -- Prompt / transparency formatting -------------------------------------

function pct(rate: number | null): string {
	return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function confidenceLabel(c: Confidence): string {
	return c === "low" ? "低" : c === "medium" ? "中" : "高";
}

function rampLabel(r: Ramp): string {
	return r === "consolidate" ? "巩固" : "拉伸";
}

function bandLine(label: string, dim: BandDimension): string {
	return `${label}：${dim.band}（证据 ${dim.evidence}，首轮通过 ${pct(dim.rate)}，置信度 ${confidenceLabel(dim.confidence)}）`;
}

/** Concise aggregate profile + explicit budget block for generation/critic prompts. */
export function formatAdaptiveBlock(profile: LearnerProfile, budget: DifficultyBudget): string {
	const focus = budget.errorFocus.length
		? budget.errorFocus.map((t) => `${t.tag}(${t.count})`).join("、")
		: "暂无";
	return [
		"<learner_profile>",
		"基于近 " + profile.windowDays + " 天答题的聚合画像（仅聚合统计，不含原始答案）：",
		bandLine("- 句法", profile.syntax),
		bandLine("- 词汇", profile.vocab),
		`- 句子首轮通过：${pct(profile.sentence.rate)}（证据 ${profile.sentence.evidence}）`,
		`- 中→英产出通过：${pct(profile.recallForward.rate)}（证据 ${profile.recallForward.evidence}）`,
		`- 英→中识别通过：${pct(profile.recallReverse.rate)}（证据 ${profile.recallReverse.evidence}）`,
		`- 辅助依赖：${pct(profile.assistance.rate)}（证据 ${profile.assistance.evidence}）`,
		`- 薄弱点：${focus}`,
		"",
		"<difficulty_budget>",
		`- 句长：${budget.wordRange[0]}-${budget.wordRange[1]} 词（句子必须在区间内）`,
		`- 句法结构：${budget.structure}`,
		`- 词汇层次：${budget.vocabulary}`,
		`- 每句生词上限：${budget.maxKeyWords}（keyWords 数量不得超过）`,
		`- 爬坡方向：${rampLabel(budget.ramp)}`,
		budget.errorFocus.length ? `- 侧重纠错：${budget.errorFocus.map((t) => t.tag).join("、")}` : "- 侧重纠错：无",
		"</difficulty_budget>",
		"</learner_profile>",
	].join("\n");
}

/** One-line transparency summary for /kaomoji:stats. */
export function formatProfileStatsLine(profile: LearnerProfile, budget: DifficultyBudget): string {
	const focus = profile.errorFocus.length ? profile.errorFocus.map((t) => t.tag).join("/") : "无";
	const dim = (d: BandDimension) => `${d.band}(证据${d.evidence},${confidenceLabel(d.confidence)})`;
	const rateEv = (r: DimensionRate) => `${pct(r.rate)}(证据${r.evidence})`;
	return [
		`画像：句法 ${dim(profile.syntax)}`,
		`词汇 ${dim(profile.vocab)}`,
		`句子首轮 ${rateEv(profile.sentence)}`,
		`中→英 ${rateEv(profile.recallForward)}`,
		`英→中 ${rateEv(profile.recallReverse)}`,
		`辅助 ${rateEv(profile.assistance)}`,
		`薄弱点 ${focus}`,
		`预算 ${budget.wordRange[0]}-${budget.wordRange[1]}词/${rampLabel(budget.ramp)}`,
	].join(" · ");
}

// -- Recent attempt log (question snapshot + answer + verdict) ------------
//
// Per-attempt audit trail persisted since schema v9 (attempts.question_text).
// Lesson generation injects a bounded, formatted slice of this log so the
// generator sees what was actually asked, how the learner answered, and how
// the evaluator ruled — including rulings whose feedback points at the
// question design itself.

export interface AttemptLogEntry {
	kind: string;
	direction: "forward" | "reverse" | null;
	question: string | null;
	answer: string | null;
	verdict: string;
	feedback: string;
	completedAt: string;
}

/** Most recent evaluated attempts with question snapshots, newest first. */
export function recentAttemptLog(db: DatabaseSync, limit = 12): AttemptLogEntry[] {
	const rows = db
		.prepare(
			"SELECT kind, direction, question_text, answer_text, verdict, feedback_json, completed_at FROM attempts " +
				"WHERE status = 'evaluated' AND verdict IN ('correct','partial','incorrect') AND completed_at IS NOT NULL " +
				"ORDER BY completed_at DESC, rowid DESC LIMIT ?",
		)
		.all(limit) as unknown as {
			kind: string;
			direction: string | null;
			question_text: string | null;
			answer_text: string | null;
			verdict: string;
			feedback_json: string | null;
			completed_at: string;
		}[];
	return rows.map((row) => {
		let feedback = "";
		if (row.feedback_json) {
			try {
				const parsed = JSON.parse(row.feedback_json) as { feedback?: unknown };
				if (typeof parsed.feedback === "string") feedback = parsed.feedback;
			} catch {
				/* keep feedback empty on corrupt JSON */
			}
		}
		return {
			kind: row.kind,
			direction: row.direction === "reverse" ? "reverse" : row.direction === "forward" ? "forward" : null,
			question: row.question_text,
			answer: row.answer_text,
			verdict: row.verdict,
			feedback,
			completedAt: row.completed_at,
		};
	});
}

/** Compact prompt block for lesson generation: recent questions, answers, verdicts. */
export function formatAttemptLogBlock(entries: AttemptLogEntry[]): string {
	if (!entries.length) return "（暂无作答记录）";
	const clip = (value: string | null, max = 60): string => {
		if (!value) return "（空）";
		const flat = value.replace(/\s+/g, " ").trim();
		return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
	};
	const kindLabel = (entry: AttemptLogEntry): string => {
		if (entry.kind === "recall") {
			return entry.direction === "reverse" ? "英→中回忆" : entry.direction === "forward" ? "中→英回忆" : "回忆";
		}
		if (entry.kind === "sentence_cloze") return "句子填空";
		if (entry.kind === "sentence_production") return "句子输出";
		return entry.kind;
	};
	const verdictLabel = (verdict: string): string =>
		verdict === "correct" ? "对" : verdict === "partial" ? "半对" : "错";
	return entries
		.map((entry) => {
			const feedback = entry.feedback ? ` | 反馈:${clip(entry.feedback, 50)}` : "";
			return `- [${kindLabel(entry)}] 题:${clip(entry.question)} | 答:${clip(entry.answer, 40)} | 判:${verdictLabel(entry.verdict)}${feedback}`;
		})
		.join("\n");
}
