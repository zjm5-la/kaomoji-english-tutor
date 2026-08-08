import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { FSRS, Rating, Card } from "fsrs.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// -- Configuration --------------------------------------------------------

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface PetConfig {
	provider?: string;
	model?: string;
	/** Reasoning/thinking level passed to the model. Omit for provider default. */
	thinkingLevel?: ThinkingLevel;
	/** How many agent turns between pet actions. */
	debounceTurns: number;
	/** Max new items (word/phrase/sentence) taught per day. */
	dailyNewLimit: number;
	maxTokens: number;
	showWidget: boolean;
	verbose: boolean;
}

const DEFAULTS: PetConfig = {
	debounceTurns: 3,
	dailyNewLimit: 3,
	maxTokens: 900,
	showWidget: true,
	verbose: false,
};

/** Models to try in order when no explicit model is configured. */
const AUTO_DETECT_MODELS = [
	"gpt-5.4-mini",
	"deepseek-v4-flash",
	"grok-4.3",
	"glm-5.2",
];
function loadConfig(cwd: string): PetConfig {
	const globalPath = join(getAgentDir(), "kaomoji-english-tutor.json");
	const projectPath = join(cwd, ".pi", "kaomoji-english-tutor.json");

	let config: PetConfig = { ...DEFAULTS };

	for (const path of [globalPath, projectPath]) {
		if (existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf-8"));
				config = { ...config, ...parsed };
			} catch (err) {
				console.error(`[kaomoji-english-tutor] Failed to load config from ${path}: ${err}`);
			}
		}
	}

	return config;
}

// -- Pet faces ------------------------------------------------------------

const FACES = {
	teach: "(=^･ω･^=)",
	review: "(=^‥^=)",
	idle: "(=ΦωΦ=)",
	party: "(=^‥^=)ﾉ",
	error: "(=；ω；=)",
} as const;

// -- SQLite storage -------------------------------------------------------

interface ItemRow {
	id: number;
	type: "word" | "phrase" | "sentence";
	text: string;
	phonetic: string | null;
	meaning: string;
	example: string | null;
	example_cn: string | null;
	learned_at: string;
	fsrs_state: string;
	due_at: string;
	shown: number;
	reviews: number;
	status: string;
	levels: string | null;
	levels_cn: string | null;
	chunks: string | null;
	key_words: string | null;
	progress: number;
}

function openDb(): DatabaseSync {
	const db = new DatabaseSync(join(getAgentDir(), "kaomoji-english-tutor.db"));
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL CHECK (type IN ('word', 'phrase', 'sentence')),
			text TEXT NOT NULL,
			phonetic TEXT,
			meaning TEXT NOT NULL,
			example TEXT,
			example_cn TEXT,
			learned_at TEXT NOT NULL,
			fsrs_state TEXT NOT NULL DEFAULT '',
			due_at TEXT NOT NULL,
			shown INTEGER NOT NULL DEFAULT 0,
			reviews INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'learning',
			levels TEXT,
			levels_cn TEXT,
			chunks TEXT,
			key_words TEXT,
			progress INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS stats (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	// Upgrade older databases without the new columns
	for (const col of [
		"status TEXT NOT NULL DEFAULT 'learning'",
		"levels TEXT",
		"levels_cn TEXT",
		"chunks TEXT",
		"key_words TEXT",
		"progress INTEGER NOT NULL DEFAULT 0",
	]) {
		try {
			db.exec(`ALTER TABLE items ADD COLUMN ${col}`);
		} catch {
			// column already exists
		}
	}
	return db;
}

function getStat(db: DatabaseSync, key: string): string | null {
	const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

function setStat(db: DatabaseSync, key: string, value: string | number) {
	db.prepare(
		"INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, String(value));
}

function bumpStat(db: DatabaseSync, key: string, delta: number) {
	setStat(db, key, Number(getStat(db, key) ?? 0) + delta);
}

function localDateStr(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function localDayStartISO(d: Date = new Date()): string {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

/** Extend the learning streak based on today's activity. */
function touchStreak(db: DatabaseSync, now: Date) {
	const today = localDateStr(now);
	const last = getStat(db, "last_active_date");
	if (last === today) return;
	const yesterday = localDateStr(new Date(now.getTime() - 24 * 3600 * 1000));
	const days = last === yesterday ? Number(getStat(db, "streak_days") ?? 0) + 1 : 1;
	setStat(db, "streak_days", days);
	setStat(db, "last_active_date", today);
}

function getDueItem(db: DatabaseSync, now: Date): ItemRow | undefined {
	return db
		.prepare("SELECT * FROM items WHERE due_at <= ? ORDER BY due_at ASC LIMIT 1")
		.get(now.toISOString()) as ItemRow | undefined;
}

function insertItem(
	db: DatabaseSync,
	type: string,
	text: string,
	phonetic: string | null,
	meaning: string,
	example: string | null,
	example_cn: string | null,
	now: Date,
	extra?: { levels?: string[]; levels_cn?: string[]; chunks?: string[]; keyWords?: GeneratedItem["keyWords"] },
) {
	db.prepare(
		"INSERT INTO items (type, text, phonetic, meaning, example, example_cn, learned_at, due_at, levels, levels_cn, chunks, key_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		type,
		text,
		phonetic,
		meaning,
		example,
		example_cn,
		now.toISOString(),
		now.toISOString(),
		extra?.levels ? JSON.stringify(extra.levels) : null,
		extra?.levels_cn ? JSON.stringify(extra.levels_cn) : null,
		extra?.chunks ? JSON.stringify(extra.chunks) : null,
		extra?.keyWords ? JSON.stringify(extra.keyWords) : null,
	);
}

/** Insert companion word cards for sentence keyWords (skipping duplicates). */
function insertCompanionWords(db: DatabaseSync, keyWords: GeneratedItem["keyWords"], now: Date) {
	for (const kw of keyWords ?? []) {
		if (!kw?.text || !kw?.meaning) continue;
		const dup = db
			.prepare("SELECT COUNT(*) AS n FROM items WHERE text = ? AND type = 'word'")
			.get(kw.text) as { n: number };
		if (Number(dup.n) > 0) continue;
		insertItem(db, "word", kw.text, kw.phonetic || null, kw.meaning, null, null, now);
	}
}

function markShown(db: DatabaseSync, id: number, fsrsState: string, dueAt: string) {
	db.prepare("UPDATE items SET shown = 1, fsrs_state = ?, due_at = ? WHERE id = ?").run(fsrsState, dueAt, id);
}

function advanceReview(db: DatabaseSync, id: number, fsrsState: string, dueAt: string, reviews: number) {
	db.prepare("UPDATE items SET fsrs_state = ?, due_at = ?, reviews = ? WHERE id = ?").run(
		fsrsState,
		dueAt,
		reviews,
		id,
	);
}

function countTodayNew(db: DatabaseSync, now: Date): number {
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM items WHERE shown = 1 AND learned_at >= ?")
		.get(localDayStartISO(now)) as { n: number };
	return Number(row.n);
}

function countTodayReviews(db: DatabaseSync, now: Date): number {
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM items WHERE reviews >= 1 AND due_at >= ? AND learned_at < ?")
		.get(localDayStartISO(now), localDayStartISO(new Date(now.getTime() + 24 * 3600 * 1000))) as { n: number };
	return Number(row.n);
}

function knownList(db: DatabaseSync): string[] {
	const rows = db.prepare("SELECT text FROM items WHERE shown = 1 ORDER BY id DESC LIMIT 30").all() as {
		text: string;
	}[];
	return rows.map((r) => r.text);
}

function latestItem(db: DatabaseSync): ItemRow | undefined {
	return db.prepare("SELECT * FROM items ORDER BY id DESC LIMIT 1").get() as ItemRow | undefined;
}

// -- FSRS scheduling ------------------------------------------------------

const scheduler = new FSRS();

/** Rebuild a Card from its stored JSON state (dates come back as strings). */
function restoreCard(stateJson: string): Card {
	const parsed = JSON.parse(stateJson) as Card;
	const card = new Card();
	card.due = new Date(parsed.due);
	card.last_review = new Date(parsed.last_review);
	card.stability = parsed.stability;
	card.difficulty = parsed.difficulty;
	card.elapsed_days = parsed.elapsed_days;
	card.scheduled_days = parsed.scheduled_days;
	card.reps = parsed.reps;
	card.lapses = parsed.lapses;
	card.state = parsed.state;
	return card;
}

/**
 * Advance a card with a rating (display-based review defaults to Good).
 * Passing null state creates the first schedule for a brand-new item.
 */
function scheduleNext(stateJson: string | null, now: Date, rating: Rating = Rating.Good): { state: string; due: string } {
	const card = stateJson ? restoreCard(stateJson) : new Card();
	const info = scheduler.repeat(card, now)[rating];
	return { state: JSON.stringify(info.card), due: info.card.due.toISOString() };
}

// -- Conversation extraction ----------------------------------------------

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

interface SessionEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/** Extract user+assistant text from a content field, collapsing tool calls. */
function renderText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as ContentBlock;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "toolCall" && typeof b.name === "string") {
			parts.push(`[调用了工具 ${b.name}]`);
		}
	}
	return parts.join("\n");
}

/** Build a compact conversation tail (last ~12 messages, ~3000 chars) for the LLM. */
function buildConversation(entries: SessionEntry[]): string {
	const parts: string[] = [];
	for (let i = Math.max(0, entries.length - 12); i < entries.length; i++) {
		const e = entries[i];
		if (e.type !== "message" || !e.message?.role) continue;
		const role = e.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = renderText(e.message.content).trim();
		if (!text) continue;
		parts.push(`${role === "user" ? "用户" : "助手"}: ${text}`);
	}
	let s = parts.join("\n");
	if (s.length > 3000) s = s.slice(-3000);
	return s;
}

// -- LLM lesson generation ------------------------------------------------

interface GeneratedItem {
	type: "word" | "phrase" | "sentence";
	text: string;
	phonetic?: string;
	meaning: string;
	example?: string;
	example_cn?: string;
	/** Sentence only: 3 progressive levels (main clause -> full sentence). */
	levels?: string[];
	/** Sentence only: per-level Chinese translations, aligned with levels. */
	levels_cn?: string[];
	/** Sentence only: chunking of the full sentence for guided reading. */
	chunks?: string[];
	/** Sentence only: likely-new words inside the sentence, with meanings. */
	keyWords?: { text: string; phonetic?: string; meaning: string }[];
}

interface Lesson {
	topic: string;
	items: GeneratedItem[];
}

interface ResolvedModel {
	provider: string;
	model: string;
	fromSession: boolean;
}

async function generateLesson(
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
): Promise<Lesson> {
	const model = ctx.modelRegistry.find(resolved.provider, resolved.model);
	if (!model) {
		const err = new Error("MODEL_NOT_FOUND");
		(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
		throw err;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) {
		const err = new Error("NO_API_KEY");
		(err as Error & { code?: string }).code = "NO_API_KEY";
		throw err;
	}

	const prompt = [
		"你是「英语小宠物」的备课大脑。看下面的会话内容，判断用户当前在做什么主题，",
		"然后围绕这个主题准备 3 个学习项：1 个单词、1 个词组、1 个句子。",
		"",
		"要求：",
		"- 内容要真实常用，宁简单不冷僻，适合中级学习者",
		"- 句子短小自然，贴近主题的实际使用场景",
		"- 只输出 JSON，不要任何其他文字：",
		'{"topic":"主题名","items":[{"type":"word","text":"单词","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"},{"type":"phrase","text":"词组","phonetic":"","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"},{"type":"sentence","text":"英文句子","phonetic":"","meaning":"中文翻译","example":"","example_cn":""}]}',
		"- 不要与已学内容重复：" + (known.length ? known.join("、") : "（暂无已学内容）"),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const llmOptions: Record<string, unknown> = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: config.maxTokens,
	};
	if (config.thinkingLevel) {
		llmOptions.reasoning = config.thinkingLevel;
	}

	const response = await completeSimple(
		model,
		{
			systemPrompt: "你是英语小宠物的备课助手，只输出 JSON 学习卡。",
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			}],
		},
		llmOptions as any,
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "provider error");
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.trim();
	if (!text) throw new Error("EMPTY_RESPONSE");

	// Tolerate markdown fences around the JSON
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("BAD_JSON");

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		throw new Error("BAD_JSON");
	}

	const items = (Array.isArray(parsed.items) ? parsed.items : [])
		.filter(
			(it): it is GeneratedItem =>
				!!it &&
				typeof it === "object" &&
				["word", "phrase", "sentence"].includes((it as GeneratedItem).type) &&
				typeof (it as GeneratedItem).text === "string" &&
				typeof (it as GeneratedItem).meaning === "string",
		)
		.slice(0, 3);
	if (!items.length) throw new Error("EMPTY_LESSON");

	// Sentence cards need levels/chunks/keyWords for progressive training.
	// Models sometimes omit them — backfill with a dedicated follow-up call.
	for (const it of items) {
		if (it.type === "sentence" && (!it.levels?.length || !it.levels_cn?.length || !it.chunks?.length || !it.keyWords?.length)) {
			await completeSentenceData(ctx, model, auth, config, it);
		}
	}

	return { topic: String(parsed.topic ?? ""), items };
}

/** Backfill levels/chunks/keyWords for a sentence card via a focused call. */
async function completeSentenceData(
	ctx: ExtensionContext,
	model: ReturnType<ExtensionContext["modelRegistry"]["find"]> & object,
	auth: { apiKey: string; headers?: Record<string, string> },
	config: PetConfig,
	item: GeneratedItem,
) {
	const prompt = [
		"为下面的英文句子生成长句训练数据，只输出 JSON：",
		'{"levels":["主干短句（去掉所有修饰成分，同一语义）","主干+一个修饰成分","与原文完全相同的完整长句"],"levels_cn":["主干短句的中文翻译","加一个成分后的中文翻译","完整长句的中文翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"中文释义"}]}',
		"要求：levels 最后一级必须与原文完全相同；levels_cn 与 levels 一一对应；chunks 是原文的意群切分（3-5 个，每个 2-6 个词）；keyWords 是句中 2-3 个可能生僻的词（含音标和中文释义）。",
		"",
		"<sentence>",
		item.text,
		"</sentence>",
	].join("\n");

	const llmOptions: Record<string, unknown> = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: 500,
	};
	if (config.thinkingLevel) {
		llmOptions.reasoning = config.thinkingLevel;
	}

	const response = await completeSimple(
		model as never,
		{
			systemPrompt: "你是英语学习卡生成器，只输出 JSON。",
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			}],
		},
		llmOptions as any,
	);

	if (response.stopReason === "error") return;
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.trim();
	if (!text) return;

	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) return;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return;
	}

	const levels = Array.isArray(parsed.levels) ? parsed.levels.filter((l): l is string => typeof l === "string") : [];
	const levelsCn = Array.isArray(parsed.levels_cn) ? parsed.levels_cn.filter((l): l is string => typeof l === "string") : [];
	const chunks = Array.isArray(parsed.chunks) ? parsed.chunks.filter((c): c is string => typeof c === "string") : [];
	const keyWords = Array.isArray(parsed.keyWords)
		? parsed.keyWords.filter((k): k is GeneratedItem["keyWords"][number] =>
				!!k && typeof k === "object" && typeof (k as { text?: unknown }).text === "string" && typeof (k as { meaning?: unknown }).meaning === "string",
			)
		: [];

	if (levels.length > 1) {
		// Guarantee the last level equals the full sentence
		levels[levels.length - 1] = item.text;
		item.levels = levels;
		if (levelsCn.length === levels.length) item.levels_cn = levelsCn;
	}
	if (chunks.length >= 2) item.chunks = chunks;
	if (keyWords.length) item.keyWords = keyWords;
}

// -- Widget rendering -----------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
	word: "单词",
	phrase: "词组",
	sentence: "句子",
};

function statsLine(db: DatabaseSync): string {
	const total = Number(
		(db.prepare("SELECT COUNT(*) AS n FROM items WHERE shown = 1 AND status = 'learning'").get() as { n: number }).n,
	);
	const mastered = Number(
		(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'mastered'").get() as { n: number }).n,
	);
	const todayReviews = countTodayReviews(db, new Date());
	const streak = Number(getStat(db, "streak_days") ?? 0);
	return `📚 已学 ${total}${mastered ? ` · 已会 ${mastered}` : ""} · 今日复习 ${todayReviews} · 连续学习 ${streak} 天`;
}

/** Parse a JSON column safely. */
function parseJsonCol<T>(raw: string | null): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/** Render a teach/review card as widget lines (front = question, back = answer). */
function renderCard(item: ItemRow, isReview: boolean, face: string, nextDue?: string, showAnswer = false): string[] {
	const label = TYPE_LABELS[item.type] ?? item.type;
	const lines: string[] = [];

	// Sentence cards: progressive reading training
	const levels = parseJsonCol<string[]>(item.levels);
	if (item.type === "sentence" && levels && levels.length > 1) {
		const level = Math.min(item.progress, levels.length - 1);
		const levelsCn = parseJsonCol<string[]>(item.levels_cn);
		const chunks = parseJsonCol<string[]>(item.chunks);
		const keyWords = parseJsonCol<{ text: string; phonetic?: string; meaning: string }[]>(item.key_words);
		lines.push(`${face} 句子训练（L${level + 1}/${levels.length}）：`);
		lines.push(`  ${levels[level]}`);
		// Front of a sentence card keeps the word hints (reading aid) but hides the translation
		if (keyWords?.length) {
			lines.push(`  📖 生词速查：${keyWords.map((k) => `${k.text} ${k.meaning}`).join(" · ")}`);
		}
		if (showAnswer) {
			if (level === levels.length - 1 && chunks?.length) {
				lines.push(`  意群：${chunks.join(" / ")}`);
			}
			lines.push(`  翻译：${levelsCn?.[level] ?? item.meaning}`);
		}
		if (level < levels.length - 1) {
			lines.push(`💬 flip 翻面看翻译 · good 升一级 · again 退一级（读到 L${levels.length} 才算完）`);
		} else {
			lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:good 记得 · /kaomoji:again 忘了`);
		}
		return lines;
	}

	if (isReview) {
		if (showAnswer) {
			lines.push(`${face} 复习：${item.text}${item.phonetic ? " " + item.phonetic : ""} — ${item.meaning}`);
			lines.push(`  第 ${item.reviews + 1} 次复习，下次 ${(nextDue ?? item.due_at).slice(0, 10)}`);
		} else {
			lines.push(`${face} 复习时间到：${item.text}${item.phonetic ? " " + item.phonetic : ""}`);
		}
		if (item.example && showAnswer) {
			lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
		}
		lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:good 记得 · /kaomoji:again 忘了`);
	} else {
		lines.push(`${face} ${label}：${item.text}${item.phonetic ? " / " + item.phonetic : ""}`);
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

// -- Extension ------------------------------------------------------------

export default function kaomojiEnglishTutorExtension(pi: ExtensionAPI) {
	// -- State ------------------------------------------------------------
	let config: PetConfig = { ...DEFAULTS };
	let db: DatabaseSync | null = null;
	let resolvedModelName = "";
	let lastError = "";
	let pendingLLMCall = false;
	let turnsSinceTick = 0;
	let latestCtx: ExtensionContext | undefined;

	function isCtxStale(ctx: ExtensionContext): boolean {
		try {
			void ctx.hasUI;
			return false;
		} catch {
			return true;
		}
	}

	function resetState() {
		lastError = "";
		pendingLLMCall = false;
		turnsSinceTick = 0;
		resolvedModelName = "";
	}

	/**
	 * Resolve the lesson model: explicit config first, then auto-detect among
	 * models whose provider has configured auth (logged in / API key present),
	 * falling back to the current session model.
	 */
	function resolveModel(ctx: ExtensionContext): { provider: string; model: string; fromSession: boolean } | undefined {
		const withAuth = (m: { provider: string; id: string }) =>
			ctx.modelRegistry.hasConfiguredAuth(m as never);

		if (config.provider && config.model) {
			const found = ctx.modelRegistry.find(config.provider, config.model);
			if (found && withAuth(found)) {
				resolvedModelName = `${config.provider}/${config.model}`;
				return { provider: config.provider, model: config.model, fromSession: false };
			}
		}

		const available = ctx.modelRegistry.getAvailable().filter(withAuth);
		for (const candidateId of AUTO_DETECT_MODELS) {
			const match = available.find((m) => m.id === candidateId);
			if (match) {
				resolvedModelName = `${match.provider}/${match.id}`;
				return { provider: match.provider, model: match.id, fromSession: false };
			}
		}

		// Last resort: the model currently driving this session (it is by
		// definition authenticated and reachable).
		if (ctx.model) {
			resolvedModelName = `${ctx.model.provider}/${ctx.model.id}（当前会话）`;
			return { provider: ctx.model.provider, model: ctx.model.id, fromSession: true };
		}

		resolvedModelName = "";
		return undefined;
	}

	function updateWidget(ctx: ExtensionContext, face: string, lines: string[]) {
		if (isCtxStale(ctx)) return;
		if (!ctx.hasUI) return;
		if (!config.showWidget) {
			ctx.ui.setWidget("kaomoji-english-tutor", undefined);
			return;
		}
		const accent = (s: string): string => {
			try {
				return ctx.ui.theme.fg("thinkingXhigh", s);
			} catch {
				return s;
			}
		};
		const cols = process.stdout.columns || 120;
		const out = lines.map((line) =>
			line.length > cols - 2 ? line.slice(0, cols - 5) + "..." : line,
		);
		ctx.ui.setWidget("kaomoji-english-tutor", out.map(accent), { placement: "belowEditor" });
	}

	function showItem(ctx: ExtensionContext, item: ItemRow, isReview: boolean, nextDue?: string) {
		if (!db) return;
		const face = isReview ? FACES.review : FACES.teach;
		pendingFlipped = false;
		pendingIsReview = isReview;
		const lines = renderCard(item, isReview, face, nextDue, false);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		if (config.verbose) {
			ctx.ui.notify(`${isReview ? "复习" : "新学"}：${item.text} — ${item.meaning}`, "info");
		}
	}

	/** Flip the pending card to its answer side. */
	function flipPending(ctx: ExtensionContext): boolean {
		if (pendingItemId == null || !db) return false;
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return true;
		pendingFlipped = true;
		const face = pendingIsReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, pendingIsReview, face, item.due_at, true);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		return true;
	}

	// -- Pet tick ---------------------------------------------------------

	/** Most recently shown card awaiting a rating/skip decision (item id). */
	let pendingItemId: number | null = null;
	/** Whether the pending card is currently showing its answer side. */
	let pendingFlipped = false;
	/** Whether the pending card is a review (vs first showing / training). */
	let pendingIsReview = false;

	/** Show the sentence card at a given level (0-based). */
	function showSentenceLevel(ctx: ExtensionContext, item: ItemRow, level: number) {
		const levels = parseJsonCol<string[]>(item.levels) ?? [item.text];
		const shown = { ...item, progress: level } as ItemRow;
		pendingFlipped = false;
		pendingIsReview = false;
		const lines = renderCard(shown, false, FACES.teach, undefined, false);
		lines.push(statsLine(db!));
		updateWidget(ctx, FACES.teach, lines);
	}

	/** Rate the pending review card; returns false if no card is awaiting a rating. */
	function ratePending(ctx: ExtensionContext, rating: Rating): boolean {
		if (pendingItemId == null || !db) return false;

		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		if (!item || item.shown === 0) return true;

		const now = new Date();
		const levels = parseJsonCol<string[]>(item.levels);

		// Sentence in progressive training: good advances a level, again steps back
		if (item.type === "sentence" && levels && levels.length > 1) {
			if (rating === Rating.Good && item.progress < levels.length - 1) {
				db.prepare("UPDATE items SET progress = ?, due_at = ? WHERE id = ?").run(
					item.progress + 1,
					now.toISOString(),
					item.id,
				);
				showSentenceLevel(ctx, item, item.progress + 1);
				pendingItemId = item.id; // keep the card up for the next rating
				return true;
			}
			if (rating === Rating.Again && item.progress > 0) {
				db.prepare("UPDATE items SET progress = ?, due_at = ? WHERE id = ?").run(
					item.progress - 1,
					now.toISOString(),
					item.id,
				);
				showSentenceLevel(ctx, item, item.progress - 1);
				pendingItemId = item.id; // keep the card up for the next rating
				return true;
			}
			// Full level + Good: hand over to FSRS (from the state saved at first showing)
			// or bottom level + Again: relearn from scratch via FSRS Again
		}

		const next = scheduleNext(item.fsrs_state, now, rating);
		advanceReview(db, item.id, next.state, next.due, item.reviews + 1);
		bumpStat(db, "total_reviews", 1);
		touchStreak(db, now);

		if (rating === Rating.Good) {
			updateWidget(ctx, FACES.review, [
				`${FACES.review} 记牢了！下次 ${next.due.slice(0, 10)} 再见这个词`,
				statsLine(db),
			]);
		} else {
			updateWidget(ctx, FACES.error, [
				`${FACES.error} 没关系，待会儿再考你一次 ${item.text}`,
				statsLine(db),
			]);
		}
		return true;
	}

	/** Mark the pending card as well-known: FSRS Easy, back in ~365 days. */
	function skipPending(ctx: ExtensionContext): boolean {
		if (pendingItemId == null || !db) return false;
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		if (!item) return true;
		const now = new Date();
		const next = scheduleNext(item.fsrs_state, now, Rating.Easy);
		// A well-known word still comes back occasionally: guarantee >= 365 days
		const minDue = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString();
		const due = next.due < minDue ? minDue : next.due;
		db.prepare("UPDATE items SET status = 'mastered', fsrs_state = ?, due_at = ? WHERE id = ?").run(
			next.state,
			due,
			item.id,
		);
		bumpStat(db, "total_skipped", 1);
		updateWidget(ctx, FACES.party, [
			`${FACES.party} 好，${item.text} 记作很熟的词，明年见！`,
			statsLine(db),
		]);
		return true;
	}

	async function petTick(ctx: ExtensionContext) {
		if (isCtxStale(ctx)) return;
		if (!db) return;
		const now = new Date();

		// 1. Due item first: show a review card (or the first showing of a new item)
		const due = getDueItem(db, now);
		if (due) {
			if (due.shown === 0) {
				const next = scheduleNext(null, now);
				markShown(db, due.id, next.state, next.due);
				touchStreak(db, now);
				pendingItemId = due.id;
				showItem(ctx, due, false);
			} else {
				const next = scheduleNext(due.fsrs_state, now);
				advanceReview(db, due.id, next.state, next.due, due.reviews + 1);
				bumpStat(db, "total_reviews", 1);
				touchStreak(db, now);
				pendingItemId = due.id;
				showItem(ctx, due, true, next.due);
			}
			return;
		}

		// 2. Otherwise teach new items (LLM), up to the daily limit
		if (countTodayNew(db, now) < config.dailyNewLimit) {
			if (pendingLLMCall) return; // an in-flight generation covers this tick
			await generateAndInsert(ctx, now);
			return;
		}

		// 3. Nothing to do: the pet dozes off
		if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
	}

	async function generateAndInsert(ctx: ExtensionContext, now: Date) {
		pendingLLMCall = true;
		if (db) updateWidget(ctx, FACES.teach, ["备课中，喵…"]);
		try {
			const resolved = resolveModel(ctx);
			if (!resolved) throw new Error("NO_MODEL");
			const conversation = buildConversation(ctx.sessionManager.getBranch());
			if (!conversation.trim()) {
				if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
				return;
			}

			let lesson: Lesson;
			try {
				lesson = await generateLesson(ctx, resolved, conversation, db ? knownList(db) : [], config);
			} catch (err) {
				// Fallback: when the chosen model is unreachable (missing auth,
				// network or provider errors), retry once with the current session
				// model — it is authenticated and known to work.
				if (!resolved.fromSession && ctx.model && ctx.model.id !== resolved.model) {
					const fallback: ResolvedModel = {
						provider: ctx.model.provider,
						model: ctx.model.id,
						fromSession: true,
					};
					lesson = await generateLesson(ctx, fallback, conversation, db ? knownList(db) : [], config);
					resolvedModelName = `${fallback.provider}/${fallback.model}（当前会话·降级）`;
				} else {
					throw err;
				}
			}

			if (!db) return;
			for (const it of lesson.items) {
				insertItem(db, it.type, it.text, it.phonetic || null, it.meaning, it.example || null, it.example_cn || null, now, {
					levels: it.levels,
					levels_cn: it.levels_cn,
					chunks: it.chunks,
					keyWords: it.keyWords,
				});
				insertCompanionWords(db, it.keyWords, now);
			}
			bumpStat(db, "total_learned", lesson.items.length);
			touchStreak(db, now);
			const first = latestItem(db);
			if (first) {
				const topicLine = lesson.topic ? `${FACES.teach} 今日主题：${lesson.topic}` : FACES.teach;
				const lines = [topicLine, ...renderCard(first, false, FACES.teach).slice(1)];
				lines.push(statsLine(db));
				updateWidget(ctx, FACES.teach, lines);
			}
			if (config.verbose) {
				ctx.ui.notify(`备好课啦：${lesson.topic || "主题"}，共 ${lesson.items.length} 个学习项`, "info");
			}
		} catch (err) {
			const msg = (err as Error)?.message || String(err);
			lastError = String((err as Error & { code?: string }).code || msg).slice(0, 80);
			if (db) updateWidget(ctx, FACES.error, [`备课失败：${lastError}`]);
		} finally {
			pendingLLMCall = false;
		}
	}

	// -- Commands ---------------------------------------------------------

	/** Authenticated, selectable models (ordered by auto-detect priority). */
	function selectableModels(ctx: ExtensionContext) {
		const available = ctx.modelRegistry.getAvailable();
		const withAuth = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
		return withAuth.sort((a, b) => {
			const ia = AUTO_DETECT_MODELS.indexOf(a.id);
			const ib = AUTO_DETECT_MODELS.indexOf(b.id);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});
	}

	/** Merge a patch into the global config file, keeping other keys. */
	function persistConfig(patch: Record<string, unknown>) {
		const globalPath = join(getAgentDir(), "kaomoji-english-tutor.json");
		try {
			const existing = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, "utf-8")) : {};
			writeFileSync(globalPath, JSON.stringify({ ...existing, ...patch }, null, 2) + "\n");
		} catch (err) {
			console.error(`[kaomoji-english-tutor] Failed to persist config: ${err}`);
		}
	}

	function applyLessonModel(ctx: ExtensionContext, spec: string) {
		const [provider, model] = spec.split("/", 2);
		if (!provider || !model) {
			ctx.ui.notify(`无效的模型格式：${spec}（应为 provider/model）`, "error");
			return false;
		}
		const found = ctx.modelRegistry.find(provider, model);
		if (!found || !ctx.modelRegistry.hasConfiguredAuth(found)) {
			ctx.ui.notify(`模型不可用或未配置密钥：${spec}`, "error");
			return false;
		}
		config.provider = provider;
		config.model = model;
		resolvedModelName = `${provider}/${model}`;
		persistConfig({ provider, model });
		ctx.ui.notify(`备课模型已设为 ${spec}（已保存，立即生效）`, "info");
		return true;
	}

	pi.registerCommand("kaomoji:model", {
		description: "Show/set the lesson model: pick from authenticated models or pass provider/model",
		handler: async (args, ctx) => {
			const target = String(args ?? "").trim();
			const models = selectableModels(ctx);

			// Show current model first
			if (!resolvedModelName) resolveModel(ctx);
			ctx.ui.notify(`当前备课模型：${resolvedModelName || "（未确定）"}`, "info");

			if (!models.length) {
				ctx.ui.notify("没有已认证的可用模型", "error");
				return;
			}

			// Bare invocation: interactive picker
			if (!target) {
				const options = models.map((m, i) => `${i + 1}. ${m.provider}/${m.id}`);
				const chosen = await ctx.ui.select("选择备课模型", options);
				if (!chosen) {
					ctx.ui.notify("已取消", "info");
					return;
				}
				const idx = parseInt(chosen.split(".")[0], 10) - 1;
				const picked = models[idx];
				if (picked) applyLessonModel(ctx, `${picked.provider}/${picked.id}`);
				return;
			}

			// Number: index into the listed models
			if (/^\d+$/.test(target)) {
				const idx = parseInt(target, 10) - 1;
				if (idx < 0 || idx >= models.length) {
					ctx.ui.notify(`编号无效（1-${models.length}）`, "error");
					return;
				}
				const picked = models[idx];
				applyLessonModel(ctx, `${picked.provider}/${picked.id}`);
				return;
			}

			// provider/model form
			if (target.includes("/")) {
				applyLessonModel(ctx, target);
				return;
			}

			ctx.ui.notify(`用法：/kaomoji:model（交互选择）或 /kaomoji:model <provider/model|编号>`, "info");
		},
	});

	// -- Event handlers ---------------------------------------------------

	pi.registerCommand("kaomoji:thinking", {
		description: "Show/set the lesson thinking level (off|minimal|low|medium|high|xhigh|max)",
		handler: async (args, ctx) => {
			const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const target = String(args ?? "").trim().toLowerCase();
			if (!target) {
				ctx.ui.notify(`当前备课思考等级：${config.thinkingLevel ?? "（provider 默认）"}`, "info");
				ctx.ui.notify(`用法：/kaomoji:thinking <${LEVELS.join("|")}>`, "info");
				return;
			}
			if (!(LEVELS as readonly string[]).includes(target)) {
				ctx.ui.notify(`无效等级：${target}（可选 ${LEVELS.join(" | ")}）`, "error");
				return;
			}
			config.thinkingLevel = target as ThinkingLevel;
			persistConfig({ thinkingLevel: target });
			ctx.ui.notify(`备课思考等级已设为 ${target}（已保存，立即生效）`, "info");
		},
	});

	pi.registerCommand("kaomoji:flip", {
		description: "Flip the shown card to reveal its answer side",
		handler: async (_args, ctx) => {
			if (pendingFlipped) {
				ctx.ui.notify("已经翻面了，直接评分吧", "info");
				return;
			}
			if (!flipPending(ctx)) {
				ctx.ui.notify("当前没有可翻面的卡片", "info");
			}
		},
	});

	pi.registerCommand("kaomoji:good", {
		description: "Rate the pending review card as remembered (FSRS Good)",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Good)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("kaomoji:again", {
		description: "Rate the pending review card as forgotten (FSRS Again)",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Again)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("kaomoji:skip", {
		description: "Skip the shown card: mark as already known, remove from review queue",
		handler: async (_args, ctx) => {
			if (!skipPending(ctx)) {
				ctx.ui.notify("当前没有可跳过的卡片", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		resetState();
		latestCtx = ctx;
		try {
			db = openDb();
		} catch (err) {
			console.error(`[kaomoji-english-tutor] Failed to open DB: ${err}`);
			db = null;
		}
		resolveModel(ctx);
		if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		turnsSinceTick++;
		if (turnsSinceTick < config.debounceTurns) return;
		turnsSinceTick = 0;
		petTick(ctx).catch(() => {
			// background failures are recorded inside petTick
		});
	});
}
