import type { DatabaseSync } from "node:sqlite";
import { countTodayNew, getStat, SCHEDULABLE, type ItemRow } from "./db.ts";

// -- Pet faces ------------------------------------------------------------

export const FACES = {
	teach: "(=^･ω･^=)",
	review: "(=^‥^=)",
	idle: "(=ΦωΦ=)",
	party: "(=^‥^=)ﾉ",
	error: "(=；ω；=)",
} as const;

// -- Widget rendering -----------------------------------------------------

export const TYPE_LABELS: Record<string, string> = {
	word: "单词",
	phrase: "词组",
	sentence: "句子",
};

function countTodayRemainingCards(db: DatabaseSync, now: Date, dailyNewLimit: number): { total: number; reviews: number; newCards: number } {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
	// Due reviews (shown items due today or earlier).
	const reviews = Number((db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 1 AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number }).n);
	// Queued replacements are quota-free; planned cards consume the remaining daily quota.
	const queuedReplacement = Number((db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 0 AND status = 'learning' AND introduction_kind = 'replacement' AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number }).n);
	const queuedPlanned = Number((db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 0 AND status = 'learning' AND (introduction_kind = 'planned' OR introduction_kind IS NULL) AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number }).n);
	const remainingPlanned = dailyNewLimit === 0
		? queuedPlanned
		: Math.min(queuedPlanned, Math.max(0, dailyNewLimit - countTodayNew(db, now)));
	const newCards = queuedReplacement + remainingPlanned;
	return { total: reviews + newCards, reviews, newCards };
}

export function formatStatusLine(db: DatabaseSync, dailyNewLimit: number): string {
	const streak = Number(getStat(db, "streak_days") ?? 0);
	const remaining = countTodayRemainingCards(db, new Date(), dailyNewLimit);
	if (remaining.total === 0) return "";
	const breakdown = remaining.newCards > 0
		? `（复习 ${remaining.reviews} · 新卡 ${remaining.newCards}）`
		: `（复习 ${remaining.reviews}）`;
	return `🔥 连续学习 ${streak} 天 · 今日剩余卡片${breakdown}`;
}

/** Parse a JSON column safely. */
export function parseJsonCol<T>(raw: string | null): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function wordEditDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			current[j] = Math.min(
			current[j - 1] + 1,
			previous[j] + 1,
			previous[j - 1] + (left[i - 1].toLowerCase() === right[j - 1].toLowerCase() ? 0 : 1),
			);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[right.length];
}

function highlightWordChange(before: string, after: string): string {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix].toLowerCase() === after[prefix].toLowerCase()) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix && suffix < after.length - prefix &&
		before[before.length - 1 - suffix].toLowerCase() === after[after.length - 1 - suffix].toLowerCase()
	) suffix++;
	const mark = (word: string) => {
		const end = word.length - suffix;
		return `${word.slice(0, prefix)}[${word.slice(prefix, end) || "∅"}]${word.slice(end)}`;
	};
	return `${mark(before)} → ${mark(after)}`;
}

export function spellingComparisonLines(answer: string | null, correctedAnswer: string | undefined, errorTags: string[]): string[] {
	if (!answer || !correctedAnswer || !errorTags.includes("spelling")) return [];
	const before = answer.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
	const after = correctedAnswer.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
	if (before.length !== after.length) return [];
	const changes = before.flatMap((word, index) => {
		const corrected = after[index];
		if (word.toLowerCase() === corrected.toLowerCase()) return [];
		return wordEditDistance(word, corrected) <= 2 ? [highlightWordChange(word, corrected)] : [];
	}).slice(0, 3);
	return changes.length ? [`🔎 拼写对比：${changes.join("；")}`] : [];
}

export interface SentenceExerciseView {
	level: number;
	kind: "sentence_cloze" | "sentence_production";
	chinese: string;
	reference: string;
	expected: string;
	focusExpression?: string;
	cloze?: string;
	hint: string;
}

const SENTENCE_STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "because", "been", "before", "but", "by", "for", "from",
	"has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "of", "on", "or", "our", "she", "so",
	"that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "will", "with", "you", "your",
]);

export function sentenceExercise(item: ItemRow, requestedLevel = item.progress): SentenceExerciseView | undefined {
	const levels = parseJsonCol<string[]>(item.levels);
	if (!levels?.length) return undefined;
	const level = Math.max(0, Math.min(requestedLevel, levels.length - 1));
	const reference = levels[level].trim();
	const levelsCn = parseJsonCol<string[]>(item.levels_cn);
	const chinese = levelsCn?.[level]?.trim() || item.meaning;
	const words = [...reference.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)];
	const keyWords = parseJsonCol<{ text: string; meaning: string }[]>(item.key_words) ?? [];
	let focusMatch = words.find((match) => keyWords.some((key) => {
		const word = match[0].toLowerCase();
		const keyWord = key.text.toLowerCase();
		return word === keyWord || word.startsWith(keyWord) || keyWord.startsWith(word);
	}));
	focusMatch ??= words
		.filter((match) => !SENTENCE_STOP_WORDS.has(match[0].toLowerCase()))
		.sort((a, b) => b[0].length - a[0].length)[0];
	const focusExpression = focusMatch?.[0];
	const firstLetterHint = (text: string) => text
		.split(/(\s+)/)
		.map((part) => /^[A-Za-z]/.test(part) ? part[0] + "_".repeat(Math.max(0, part.replace(/[^A-Za-z]/g, "").length - 1)) : part)
		.join("");
	if (level === 0 && focusMatch?.index != null) {
		const start = focusMatch.index;
		const cloze = reference.slice(0, start) + "____" + reference.slice(start + focusMatch[0].length);
		return {
			level,
			kind: "sentence_cloze",
			chinese,
			reference,
			expected: focusMatch[0],
			focusExpression,
			cloze,
			hint: firstLetterHint(focusMatch[0]),
		};
	}
	return {
		level,
		kind: "sentence_production",
		chinese,
		reference,
		expected: reference,
		focusExpression,
		hint: firstLetterHint(reference),
	};
}

/** Canonical recall question text — single source for card display and attempt logs. */
export function recallQuestionText(item: ItemRow, direction: "forward" | "reverse"): string {
	return direction === "reverse"
		? `写出「${item.text}」的中文释义`
		: `默写「${item.meaning}」的英文`;
}

/** Canonical sentence-level question text for attempt logs. */
export function sentenceQuestionText(exercise: SentenceExerciseView): string {
	return exercise.kind === "sentence_cloze"
		? `L${exercise.level + 1} 填空：${exercise.cloze}`
		: `L${exercise.level + 1} 中文：${exercise.chinese}`;
}

/** Render a teach/review card as widget lines (front = question, back = answer). */
export function renderCard(item: ItemRow, isReview: boolean, face: string, showAnswer = false, direction: "forward" | "reverse" = "forward"): string[] {
	const label = TYPE_LABELS[item.type] ?? item.type;
	const lines: string[] = [];

	// Sentence cards use progressive written production rather than self-reported reading.
	const levels = parseJsonCol<string[]>(item.levels);
	if (item.type === "sentence" && levels && levels.length > 1) {
		const exercise = sentenceExercise(item);
		if (!exercise) return lines;
		const chunks = parseJsonCol<string[]>(item.chunks);
		lines.push(`${face} 句子输出（L${exercise.level + 1}/${levels.length}）：`);
		lines.push(`  中文：${exercise.chinese}`);
		if (exercise.kind === "sentence_cloze") {
			lines.push(`  填空：${exercise.cloze}`);
			lines.push("  只需写出缺失的英文词，也可以写完整句子。");
		} else {
			lines.push("  请写出自然英文，不要求与参考句逐字一致。");
			if (exercise.focusExpression) lines.push(`  尽量使用：${exercise.focusExpression}`);
		}
		if (showAnswer) {
			lines.push(`  参考：${exercise.reference}`);
			if (exercise.level === levels.length - 1 && chunks?.length) lines.push(`  意群：${chunks.join(" / ")}`);
		}
		lines.push("💬 /kaomoji:answer <英文> · /kaomoji:hint · /kaomoji:flip · /kaomoji:again");
		return lines;
	}

	if (isReview) {
		if (showAnswer) {
			lines.push(`${face} 复习：${item.text}${item.phonetic ? " " + item.phonetic : ""} — ${item.meaning}`);
			lines.push(`  第 ${item.reviews + 1} 次复习`);
		} else {
			lines.push(`${face} 复习时间到：✍️ ${recallQuestionText(item, direction)}`);
		}
		if (item.example && showAnswer) {
			lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
		}
		lines.push(`💬 /kaomoji:answer 默写 · /kaomoji:hint 提示 · /kaomoji:flip 翻面 · /kaomoji:good 记得 · /kaomoji:again 忘了`);
	} else {
		lines.push(`${face} ${label}：${item.text}${item.phonetic ? " " + item.phonetic : ""}`);
		if (showAnswer) {
			lines.push(`  释义：${item.meaning}`);
			if (item.example) {
				lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
			}
		}
		lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:skip 已会`);
	}
	return lines;
}
