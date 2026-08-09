import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { FSRS, Rating, Card } from "fsrs.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

// -- Configuration --------------------------------------------------------

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface PetConfig {
	provider?: string;
	model?: string;
	/** Reasoning/thinking level passed to the model. Omit for provider default. */
	thinkingLevel?: ThinkingLevel;
	/** Minutes between automatic lesson/review checks. Zero disables the timer. */
	intervalMinutes: number;
	/** Max new items (word/phrase/sentence) taught per day. */
	dailyNewLimit: number;
	maxTokens: number;
	showWidget: boolean;
	verbose: boolean;
}

const DEFAULTS: PetConfig = {
	intervalMinutes: 10,
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

	if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 0 || config.intervalMinutes > 1440) {
		config.intervalMinutes = DEFAULTS.intervalMinutes;
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
		PRAGMA busy_timeout = 5000;
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
	// Single global card-slot row.
	db.exec(`
		CREATE TABLE IF NOT EXISTS runtime_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			active_item_id INTEGER,
			active_kind TEXT,
			active_version INTEGER NOT NULL DEFAULT 0,
			next_check_at TEXT NOT NULL,
			coordinator TEXT,
			coordinator_until TEXT,
			generation_token TEXT,
			generation_until TEXT,
			last_activity TEXT
		);
		INSERT OR IGNORE INTO runtime_state (id, active_version, next_check_at) VALUES (1, 0, '');
	`);
	for (const col of ["generation_token TEXT", "generation_until TEXT"]) {
		try {
			db.exec(`ALTER TABLE runtime_state ADD COLUMN ${col}`);
		} catch {
			// column already exists
		}
	}
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
		.prepare("SELECT * FROM items WHERE due_at <= ? ORDER BY due_at ASC, id ASC LIMIT 1")
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
): number {
	const result = db.prepare(
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
	return Number(result.lastInsertRowid);
}

/** Insert companion word cards for sentence keyWords (skipping duplicates). */
function insertCompanionWords(db: DatabaseSync, keyWords: GeneratedItem["keyWords"], now: Date) {
	for (const kw of keyWords ?? []) {
		if (!kw?.text || !kw?.meaning) continue;
		const dup = db
			.prepare("SELECT COUNT(*) AS n FROM items WHERE type = 'word' AND lower(trim(text)) = lower(trim(?)) AND trim(meaning) = trim(?)")
			.get(kw.text, kw.meaning) as { n: number };
		if (Number(dup.n) > 0) continue;
		insertItem(db, "word", kw.text, kw.phonetic || null, kw.meaning, null, null, now);
	}
}

function markShown(db: DatabaseSync, id: number) {
	db.prepare("UPDATE items SET shown = 1 WHERE id = ?").run(id);
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
		.prepare(
			"SELECT COUNT(*) AS n FROM items WHERE reviews >= 1 AND json_extract(fsrs_state, '$.last_review') >= ? AND json_extract(fsrs_state, '$.last_review') < ?",
		)
		.get(localDayStartISO(now), localDayStartISO(new Date(now.getTime() + 24 * 3600 * 1000))) as { n: number };
	return Number(row.n);
}

function knownList(db: DatabaseSync): string[] {
	const rows = db.prepare("SELECT text FROM items WHERE shown = 1 ORDER BY id DESC LIMIT 30").all() as {
		text: string;
	}[];
	return rows.map((r) => r.text);
}

function replacementKnownList(db: DatabaseSync): string[] {
	const rows = db.prepare("SELECT type, text, meaning FROM items ORDER BY id DESC LIMIT 50").all() as Array<{
		type: string;
		text: string;
		meaning: string;
	}>;
	return rows.map((row) => `${row.type}: ${row.text} = ${row.meaning}`);
}

function pendingReplacementTypes(db: DatabaseSync): GeneratedItem["type"][] {
	const raw = getStat(db, "pending_replacements");
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((type): type is GeneratedItem["type"] =>
			type === "word" || type === "phrase" || type === "sentence"
		);
	} catch {
		return [];
	}
}

function enqueueReplacement(db: DatabaseSync, type: GeneratedItem["type"]) {
	setStat(db, "pending_replacements", JSON.stringify([...pendingReplacementTypes(db), type]));
}

function consumeReplacement(db: DatabaseSync, type: GeneratedItem["type"]): boolean {
	const queue = pendingReplacementTypes(db);
	if (queue[0] !== type) return false;
	queue.shift();
	setStat(db, "pending_replacements", JSON.stringify(queue));
	return true;
}

// -- Multi-session runtime state ------------------------------------------

/**
 * Single global learning slot shared across every concurrent Pi session.
 * One row (id=1) in SQLite is the single source of truth; each process keeps
 * only a local cache of the active card for rendering. State transitions that
 * must happen at most once globally (rating, skip, claiming a due card) run in
 * short `BEGIN IMMEDIATE` transactions with optimistic CAS checks.
 */

/** Expiry and renewal cadence of the coordinator lease. */
const COORDINATOR_LEASE_MS = 15_000;
const COORDINATOR_HEARTBEAT_MS = 5_000;
const GENERATION_LEASE_MS = 5 * 60_000;
/** How often each process polls SQLite for cross-session changes. */
const SYNC_POLL_MS = 1000;
/** Grace window a session has to own an in-flight replacement generation. */
const REPLACEMENT_GRACE_MS = 8000;

interface RuntimeState {
	active_item_id: number | null;
	active_kind: "review" | "teach" | null;
	active_version: number;
	next_check_at: string;
	coordinator: string | null;
	coordinator_until: string | null;
	generation_token: string | null;
	generation_until: string | null;
	last_activity: string | null;
}

/** Build the non-null default runtime state when the row is missing. */
function defaultRuntimeState(): RuntimeState {
	return {
		active_item_id: null,
		active_kind: null,
		active_version: 0,
		next_check_at: new Date(0).toISOString(),
		coordinator: null,
		coordinator_until: null,
		generation_token: null,
		generation_until: null,
		last_activity: null,
	};
}

function getRuntimeState(db: DatabaseSync): RuntimeState {
	let row = db.prepare("SELECT * FROM runtime_state WHERE id = 1").get() as RuntimeState | undefined;
	if (!row) {
		db.prepare("INSERT OR IGNORE INTO runtime_state (id, active_version, next_check_at) VALUES (1, 0, '')").run();
		row = db.prepare("SELECT * FROM runtime_state WHERE id = 1").get() as RuntimeState | undefined;
	}
	if (!row) return defaultRuntimeState();
	return {
		active_item_id: row.active_item_id,
		active_kind: row.active_kind as RuntimeState["active_kind"],
		active_version: Number(row.active_version ?? 0),
		next_check_at: row.next_check_at ?? "",
		coordinator: row.coordinator,
		coordinator_until: row.coordinator_until,
		generation_token: row.generation_token,
		generation_until: row.generation_until,
		last_activity: row.last_activity,
	};
}

const RUNTIME_COLUMNS = new Set<keyof RuntimeState>([
	"active_item_id",
	"active_kind",
	"active_version",
	"next_check_at",
	"coordinator",
	"coordinator_until",
	"generation_token",
	"generation_until",
	"last_activity",
]);

/** Update only the supplied columns so unrelated cross-process state cannot be clobbered. */
function setRuntimeState(db: DatabaseSync, patch: Partial<RuntimeState>) {
	const entries = Object.entries(patch).filter(([key]) => RUNTIME_COLUMNS.has(key as keyof RuntimeState));
	if (!entries.length) return;
	const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
	db.prepare(`UPDATE runtime_state SET ${assignments} WHERE id = 1`).run(...entries.map(([, value]) => value));
}

/** True when the global pacing window (next_check_at) has elapsed. */
function pacingReady(state: RuntimeState, now: Date): boolean {
	if (!state.next_check_at) return true;
	return now.getTime() >= new Date(state.next_check_at).getTime();
}

/** My coordinator identity: `<sessionId>::<instanceToken>`. */
function myCoordinatorId(sessionId: string, instanceToken: string): string {
	return `${sessionId || "session"}::${instanceToken}`;
}

/** Lower the global pacing window to `now` (used when a card is activated). */
function resetPacing(db: DatabaseSync) {
	setRuntimeState(db, { next_check_at: new Date().toISOString() });
}

function activeItem(db: DatabaseSync): ItemRow | undefined {
	const state = getRuntimeState(db);
	if (state.active_item_id == null) return undefined;
	return db.prepare("SELECT * FROM items WHERE id = ?").get(state.active_item_id) as ItemRow | undefined;
}

function latestMasteredItem(db: DatabaseSync, type: GeneratedItem["type"]): ItemRow | undefined {
	return db
		.prepare("SELECT * FROM items WHERE type = ? AND status = 'mastered' ORDER BY id DESC LIMIT 1")
		.get(type) as ItemRow | undefined;
}

// -- FSRS scheduling ------------------------------------------------------

const scheduler = new FSRS();

/** Rebuild a Card from its stored JSON state (dates come back as strings). */
function restoreCard(stateJson: string): Card {
	try {
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
	} catch {
		return new Card();
	}
}

/**
 * Advance a card only after an explicit user rating.
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

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) return undefined;
	return value;
}

function keyWordArray(value: unknown): GeneratedItem["keyWords"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: NonNullable<GeneratedItem["keyWords"]> = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const record = entry as Record<string, unknown>;
		if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) {
			return undefined;
		}
		if (record.phonetic != null && typeof record.phonetic !== "string") return undefined;
		result.push({ text: record.text, meaning: record.meaning, phonetic: record.phonetic as string | undefined });
	}
	return result;
}

function parseGeneratedItem(raw: unknown, expectedType?: GeneratedItem["type"]): GeneratedItem | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const type = record.type;
	if (type !== "word" && type !== "phrase" && type !== "sentence") return undefined;
	if (expectedType && type !== expectedType) return undefined;
	if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) return undefined;
	for (const key of ["phonetic", "example", "example_cn"] as const) {
		if (record[key] != null && typeof record[key] !== "string") return undefined;
	}
	const item: GeneratedItem = {
		type,
		text: record.text,
		meaning: record.meaning,
		phonetic: record.phonetic as string | undefined,
		example: record.example as string | undefined,
		example_cn: record.example_cn as string | undefined,
	};
	if (type === "sentence") {
		if (record.levels != null && !(item.levels = stringArray(record.levels))) return undefined;
		if (record.levels_cn != null && !(item.levels_cn = stringArray(record.levels_cn))) return undefined;
		if (record.chunks != null && !(item.chunks = stringArray(record.chunks))) return undefined;
		if (record.keyWords != null && !(item.keyWords = keyWordArray(record.keyWords))) return undefined;
	}
	return item;
}

function validSentenceTraining(item: GeneratedItem): boolean {
	if (item.type !== "sentence" || !item.levels || !item.levels_cn || !item.chunks || !item.keyWords) return false;
	const fullWords = item.text.trim().split(/\s+/).length;
	const middleWords = item.levels[1]?.trim().split(/\s+/).length ?? 0;
	return (
		fullWords >= 15 &&
		item.levels.length === 3 &&
		new Set(item.levels.map((level) => level.trim())).size === 3 &&
		item.levels_cn.length === 3 &&
		item.chunks.length >= 2 && item.chunks.length <= 5 &&
		item.keyWords.length >= 1 && item.keyWords.length <= 3 &&
		item.levels[2].trim() === item.text.trim() &&
		middleWords / fullWords >= 0.35 && middleWords / fullWords <= 0.9
	);
}

interface ReadyLesson {
	ready: true;
	topic: string;
	items: GeneratedItem[];
}

interface WaitingLesson {
	ready: false;
	reason?: string;
}

type LessonDecision = ReadyLesson | WaitingLesson;

interface ReadyReplacement {
	ready: true;
	item: GeneratedItem;
}

type ReplacementDecision = ReadyReplacement | WaitingLesson;

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
): Promise<LessonDecision> {
	const model = ctx.modelRegistry.find(resolved.provider, resolved.model);
	if (!model) {
		const err = new Error("MODEL_NOT_FOUND");
		(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
		throw err;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		const err = new Error("NO_API_KEY");
		(err as Error & { code?: string }).code = "NO_API_KEY";
		throw err;
	}
	const requestAuth = {
		apiKey: auth.apiKey,
		headers: auth.headers as Record<string, string> | undefined,
	};

	const prompt = [
		"你是「英语小宠物」的备课大脑。先判断下面的会话是否已经形成值得学习的明确主题。",
		"如果信息不足，只输出：{\"ready\":false,\"reason\":\"简短原因\"}。不要为了完成任务硬凑学习卡。",
		"只有信息充分时，才围绕主题准备 3 个学习项：1 个单词、1 个词组、1 个渐进长句。",
		"",
		"备课条件：",
		"- 已形成相对明确、稳定的话题，有足够上下文生成真实有用的英语内容",
		"- 不能只是寒暄、数字、命令、测试占位文本或环境通知",
		"- 不确定时必须返回 ready=false，等待后续会话补充信息",
		"",
		"学习项要求：",
		"- 内容要真实常用，宁简单不冷僻，适合中级学习者",
		"- word 和 phrase 的例句短小自然，贴近主题的实际使用场景",
		"- sentence 的 text 必须是真正的长句：至少 15 个单词，包含从句或插入成分；禁止用简单句或短句充数",
		"- 长句结构要多样化：定语从句、状语从句、宾语从句、插入语、分词短语、同位语等轮换使用，避免总是使用 which 定语从句",
		"- sentence 必须带 levels（3 个渐进级别，最后一级与 text 相同）、levels_cn（与 levels 一一对应的逐级中文翻译）、chunks（3-5 个意群）、keyWords（2-3 个生词）",
		"- levels 必须均匀递进且互不相同：每一级只增加一个主要意群，L2 的词数应约为 L3 的 50%-75%，禁止从很短的 L2 突然跳到完整长句",
		"- levels_cn 必须是自然地道的中文，准确对应各级英文，避免逐字直译和同词重复造成的生硬表达",
		"- 只输出 JSON，不要任何其他文字：",
		'{"ready":true,"topic":"主题名","items":[{"type":"word","text":"单词","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"},{"type":"phrase","text":"词组","phonetic":"","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"},{"type":"sentence","text":"完整长句","phonetic":"","meaning":"完整长句的中文翻译","example":"","example_cn":"","levels":["主干短句","加一个成分后的句子","与text相同的完整长句"],"levels_cn":["主干短句的翻译","第二级的翻译","完整长句的翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"中文释义"}]}]}',
		"- 不要与已学内容重复，也要避开相同句型：" + (known.length ? known.join("、") : "（暂无已学内容）"),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const llmOptions: Record<string, unknown> = {
		apiKey: requestAuth.apiKey,
		headers: requestAuth.headers,
		maxTokens: config.maxTokens,
	};
	if (config.thinkingLevel) {
		llmOptions.reasoning = config.thinkingLevel;
	}

	const response = await completeSimple(
		model,
		{
			systemPrompt: "你是英语小宠物的备课助手，只输出 JSON；信息不足时宁可等待。",
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

	if (parsed.ready === false) {
		return {
			ready: false,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");

	if (!Array.isArray(parsed.items) || parsed.items.length !== 3) throw new Error("INVALID_LESSON_SHAPE");
	const parsedItems = parsed.items.map((item) => parseGeneratedItem(item));
	if (parsedItems.some((item) => item == null)) throw new Error("INVALID_LESSON_ITEM");
	const items = parsedItems as GeneratedItem[];
	if (new Set(items.map((item) => item.type)).size !== 3) throw new Error("INVALID_LESSON_SHAPE");

	// Sentence cards need levels/chunks/keyWords for progressive training.
	// Models sometimes omit them — backfill with a dedicated follow-up call.
	for (const it of items) {
		if (it.type === "sentence" && !validSentenceTraining(it)) {
			await completeSentenceData(model, requestAuth, config, it);
		}
	}
	const sentence = items.find((item) => item.type === "sentence")!;
	if (!validSentenceTraining(sentence)) throw new Error("INVALID_SENTENCE_TRAINING");

	return { ready: true, topic: String(parsed.topic ?? ""), items };
}

async function generateReplacement(
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
	skipped: ItemRow,
): Promise<ReplacementDecision> {
	const model = ctx.modelRegistry.find(resolved.provider, resolved.model);
	if (!model) throw new Error("MODEL_NOT_FOUND");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error("NO_API_KEY");
	const requestAuth = {
		apiKey: auth.apiKey,
		headers: auth.headers as Record<string, string> | undefined,
	};
	const itemSchema = skipped.type === "sentence"
		? '{"type":"sentence","text":"完整长句","meaning":"中文翻译","levels":["L1主干","L2扩展","与text相同的L3"],"levels_cn":["L1翻译","L2翻译","L3翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"释义"}]}'
		: `{"type":"${skipped.type}","text":"${skipped.type === "word" ? "单词" : "词组"}","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句翻译"}`;
	const prompt = [
		`用户刚把 ${skipped.type} 卡片「${skipped.text} = ${skipped.meaning}」标记为已经很熟。`,
		`请根据会话主题补充 1 张新的 ${skipped.type} 卡片，不能与已有内容重复。`,
		"如果会话信息不足以生成真实有用的同类型卡片，只输出：{\"ready\":false,\"reason\":\"简短原因\"}。",
		"信息充分时只输出：",
		`{"ready":true,"item":${itemSchema}}`,
		skipped.type === "sentence"
			? "句子必须至少 15 个单词；levels 均匀递进且互不相同，L2 约为 L3 的 50%-75%；逐级翻译使用自然中文。"
			: "内容要真实常用，贴近当前会话主题，适合中级学习者。",
		"已有内容：" + (known.length ? known.join("；") : "（无）"),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");
	const llmOptions: Record<string, unknown> = {
		apiKey: requestAuth.apiKey,
		headers: requestAuth.headers,
		maxTokens: skipped.type === "sentence" ? config.maxTokens : 450,
	};
	if (config.thinkingLevel) llmOptions.reasoning = config.thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: "你是英语学习卡生成器，只输出 JSON；信息不足时宁可等待。",
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			}],
		},
		llmOptions as any,
	);
	if (response.stopReason === "error") throw new Error(response.errorMessage || "provider error");
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join(" ")
		.trim();
	if (!text) throw new Error("EMPTY_RESPONSE");
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
	if (parsed.ready === false) {
		return { ready: false, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");
	const item = parseGeneratedItem(parsed.item, skipped.type);
	if (!item) throw new Error("EMPTY_REPLACEMENT");
	if (item.type === "sentence" && !validSentenceTraining(item)) {
		await completeSentenceData(model, requestAuth, config, item);
	}
	if (item.type === "sentence" && !validSentenceTraining(item)) throw new Error("INVALID_REPLACEMENT_SENTENCE");
	return { ready: true, item };
}

/** Backfill levels/chunks/keyWords for a sentence card via a focused call. */
async function completeSentenceData(
	model: ReturnType<ExtensionContext["modelRegistry"]["find"]> & object,
	auth: { apiKey: string; headers?: Record<string, string> },
	config: PetConfig,
	item: GeneratedItem,
) {
	const prompt = [
		"为下面的英文句子生成长句训练数据，只输出 JSON：",
		'{"levels":["主干短句（去掉所有修饰成分，同一语义）","主干+一个修饰成分","与原文完全相同的完整长句"],"levels_cn":["主干短句的中文翻译","加一个成分后的中文翻译","完整长句的中文翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"中文释义"}]}',
		"要求：levels 最后一级必须与原文完全相同；三个级别互不相同，每级只增加一个主要意群，L2 词数约为 L3 的 50%-75%；levels_cn 与 levels 一一对应，使用自然地道的中文；chunks 是原文的意群切分（3-5 个）；keyWords 是句中 2-3 个可能生僻的词（含音标和中文释义）。",
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

	const levels = stringArray(parsed.levels);
	const levelsCn = stringArray(parsed.levels_cn);
	const chunks = stringArray(parsed.chunks);
	const keyWords = keyWordArray(parsed.keyWords);
	if (levels?.length === 3) {
		levels[2] = item.text;
		item.levels = levels;
	}
	if (levelsCn?.length === 3) item.levels_cn = levelsCn;
	if (chunks) item.chunks = chunks;
	if (keyWords) item.keyWords = keyWords;
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
	const now = new Date();
	const todayNew = countTodayNew(db, now);
	const todayReviews = countTodayReviews(db, now);
	const streak = Number(getStat(db, "streak_days") ?? 0);
	return `📚 已学 ${total} · 今日新增 ${todayNew} · 今日复习 ${todayReviews} · 连续学习 ${streak} 天`;
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
function renderCard(item: ItemRow, isReview: boolean, face: string, showAnswer = false): string[] {
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
		if (level === 0) {
			lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:good 升到 L2 · /kaomoji:again 忘了（下次从 L1）`);
		} else if (level < levels.length - 1) {
			lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:good 升到 L${level + 2} · /kaomoji:again 忘了（下次从 L1）`);
		} else {
			lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:good 完成并进入复习 · /kaomoji:again 忘了（下次从 L1）`);
		}
		return lines;
	}

	if (isReview) {
		if (showAnswer) {
			lines.push(`${face} 复习：${item.text}${item.phonetic ? " " + item.phonetic : ""} — ${item.meaning}`);
			lines.push(`  第 ${item.reviews + 1} 次复习`);
		} else {
			lines.push(`${face} 复习时间到：${item.text}${item.phonetic ? " " + item.phonetic : ""}`);
		}
		if (item.example && showAnswer) {
			lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
		}
		lines.push(`💬 /kaomoji:flip 翻面 · /kaomoji:good 记得 · /kaomoji:again 忘了`);
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

// -- Extension ------------------------------------------------------------

export default function kaomojiEnglishTutorExtension(pi: ExtensionAPI) {
	// -- State ------------------------------------------------------------
	let config: PetConfig = { ...DEFAULTS };
	let db: DatabaseSync | null = null;
	let resolvedModelName = "";
	let lastError = "";
	let pendingLLMCall = false;
	let lastRejectedConversation = "";
	let lastRejectedReplacementKey = "";
	let sessionGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let latestCtx: ExtensionContext | undefined;
	/** Per-runtime identity; distinct even when two processes open the same logical session. */
	const instanceToken = randomUUID();
	/** Current session id, for the coordinator lease identity. */
	let sessionId = "";
	/** My `sessionId::instanceToken` coordinator identity. */
	let myId = "";
	let lastCoordinatorRenewal = 0;
	/** Last active_version we rendered locally (to detect cross-session card changes). */
	let localVersion = -1;
	/** Cached `PRAGMA data_version` to avoid redundant SQLite reads. */
	let lastDataVersion: number | null = null;
	/** Most recently shown card awaiting a rating/skip decision (mirrors the global slot). */
	let pendingItemId: number | null = null;
	/** Whether the pending card is currently showing its answer side (local-only). */
	let pendingFlipped = false;
	/** Whether the pending card is a review (vs first showing / training). */
	let pendingIsReview = false;

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
		lastRejectedConversation = "";
		lastRejectedReplacementKey = "";
		resolvedModelName = "";
	}

	function stopTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function intervalMs(): number {
		return Math.max(0, config.intervalMinutes) * 60_000;
	}

	function scheduleTimer(delay = intervalMs()) {
		stopTimer();
		if (!latestCtx || config.intervalMinutes <= 0 || db == null || activeItem(db) != null) return;
		const state = getRuntimeState(db);
		const pacingDelay = state.next_check_at
			? new Date(state.next_check_at).getTime() - Date.now()
			: 0;
		const effectiveDelay = pacingDelay > 0 ? pacingDelay : delay;
		timer = setTimeout(() => {
			timer = undefined;
			void runTimerTick();
		}, Math.max(0, effectiveDelay));
		timer.unref?.();
	}

	async function runTimerTick() {
		const ctx = latestCtx;
		const generation = sessionGeneration;
		if (!ctx || isCtxStale(ctx) || config.intervalMinutes <= 0) return;
		if ((typeof ctx.isIdle === "function" && !ctx.isIdle()) || pendingLLMCall) {
			scheduleTimer(Math.min(30_000, intervalMs()));
			return;
		}
		try {
			await petTick(ctx);
		} catch (err) {
			console.error(`[kaomoji-english-tutor] Timer tick failed: ${err}`);
		}
		if (sessionGeneration !== generation) return;
		// Keep re-evaluating unless leaving a locally-rated card up for this session.
		if (pendingItemId == null) scheduleTimer();
	}


	/** Close the session-scoped SQLite connection before reload/switch/exit. */
	function closeDb() {
		stopPolling();
		const current = db;
		db = null;
		if (!current) return;
		try {
			current.close();
		} catch (err) {
			console.error(`[kaomoji-english-tutor] Failed to close DB: ${err}`);
		}
	}

	// -- Coordinator lease & cross-session sync ----------------------------

	/** Stop the cross-session poll timer. */
	function stopPolling() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	}

	function leaseMs(): number {
		return COORDINATOR_LEASE_MS;
	}

	/** I hold the current, unexpired coordinator lease. */
	function iAmCoordinator(state: RuntimeState, now: Date): boolean {
		return Boolean(
			myId &&
			state.coordinator === myId &&
			state.coordinator_until &&
			now.getTime() < new Date(state.coordinator_until).getTime()
		);
	}

	/** Acquire/renew leadership, or force takeover after real user activity. */
	function ensureCoordinator(now = new Date(), force = false): boolean {
		if (!db || !myId) return false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			const expired = !state.coordinator || !state.coordinator_until ||
				now.getTime() >= new Date(state.coordinator_until).getTime();
			if (!force && state.coordinator !== myId && !expired) {
				db.exec("ROLLBACK");
				return false;
			}
			const changedOwner = state.coordinator !== myId;
			setRuntimeState(db, {
				coordinator: myId,
				coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(),
				last_activity: now.toISOString(),
				...(changedOwner ? { generation_token: null, generation_until: null } : {}),
			});
			db.exec("COMMIT");
			lastCoordinatorRenewal = now.getTime();
			return true;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[kaomoji-english-tutor] Coordinator lease failed: ${err}`);
			return false;
		}
	}

	/** Release only this runtime's ownership; never disturb a newer session. */
	function releaseCoordinator() {
		if (!db || !myId) return;
		db.prepare(
			"UPDATE runtime_state SET coordinator = NULL, coordinator_until = NULL, generation_token = NULL, generation_until = NULL WHERE id = 1 AND coordinator = ?",
		).run(myId);
	}

	/** Claim one generation token without holding a transaction across the LLM call. */
	function claimGeneration(now = new Date()): string | null {
		if (!ensureCoordinator(now)) return null;
		const token = randomUUID();
		try {
			db!.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db!);
			const generationBusy = Boolean(
				state.generation_token && state.generation_until &&
				now.getTime() < new Date(state.generation_until).getTime()
			);
			if (!iAmCoordinator(state, now) || generationBusy) {
				db!.exec("ROLLBACK");
				return null;
			}
			setRuntimeState(db!, {
				generation_token: token,
				generation_until: new Date(now.getTime() + GENERATION_LEASE_MS).toISOString(),
			});
			db!.exec("COMMIT");
			return token;
		} catch (err) {
			try { db!.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[kaomoji-english-tutor] Generation lease failed: ${err}`);
			return null;
		}
	}

	function ownsGeneration(state: RuntimeState, token: string, now = new Date()): boolean {
		return Boolean(
			iAmCoordinator(state, now) &&
			state.generation_token === token &&
			state.generation_until &&
			now.getTime() < new Date(state.generation_until).getTime()
		);
	}

	function releaseGeneration(token: string) {
		if (!db) return;
		db.prepare(
			"UPDATE runtime_state SET generation_token = NULL, generation_until = NULL WHERE id = 1 AND coordinator = ? AND generation_token = ?",
		).run(myId, token);
	}

	/** Bump the global card version and cache the rendered state locally. */
	function recordRendered(state: RuntimeState | undefined) {
		if (!state) {
			localVersion = -1;
			return;
		}
		localVersion = state.active_version;
	}

	/**
	 * Re-render the widget from the global active card. Returns true when the
	 * global card changed (so the caller knows a stale local panel should close).
	 */
	function renderGlobalCard(ctx: ExtensionContext): boolean {
		if (!db) return false;
		const state = getRuntimeState(db);
		const changed = state.active_version !== localVersion;
		const item = activeItem(db);
		if (item && state.active_kind) {
			const isReview = state.active_kind === "review";
			pendingItemId = state.active_item_id;
			pendingIsReview = isReview;
			if (changed || pendingFlipped === false) pendingFlipped = false;
			const lines = renderCard(item, isReview, isReview ? FACES.review : FACES.teach, pendingFlipped);
			lines.push(statsLine(db));
			updateWidget(ctx, isReview ? FACES.review : FACES.teach, lines);
			recordRendered(state);
		} else {
			// No global card: reflect cleared state (respecting pacing status line).
			pendingItemId = null;
			pendingFlipped = false;
			pendingIsReview = false;
			if (changed || localVersion < 0) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
				recordRendered(state);
			}
		}
		return changed;
	}

	/**
	 * Poll SQLite for cross-session changes (~1s) using PRAGMA data_version.
	 * Re-renders the global card and resumes timer work after another session
	 * rates/skips the active card so every process converges on the same card.
	 */
	function startPolling() {
		stopPolling();
		if (!db || !latestCtx) return;
		try {
			lastDataVersion = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
			renderGlobalCard(latestCtx);
		} catch {
			lastDataVersion = null;
		}
		const tick = () => {
			if (!db || !latestCtx || isCtxStale(latestCtx)) {
				pollTimer = undefined;
				return;
			}
			try {
				const version = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
				if (lastDataVersion === null || version !== lastDataVersion) {
					lastDataVersion = version;
					const previousActive = pendingItemId;
					renderGlobalCard(latestCtx);
					const state = getRuntimeState(db);
					if (state.active_item_id != null) {
						stopTimer();
					} else if (previousActive != null && config.intervalMinutes > 0) {
						// scheduleTimer respects the persisted next_check_at pacing boundary.
						scheduleTimer(0);
					}
				}
				const state = getRuntimeState(db);
				const generationExpired = Boolean(
					pendingLLMCall && (!state.generation_until || Date.now() >= new Date(state.generation_until).getTime())
				);
				if (!generationExpired && state.coordinator === myId && Date.now() - lastCoordinatorRenewal >= COORDINATOR_HEARTBEAT_MS) {
					ensureCoordinator(new Date());
				}
			} catch (err) {
				console.error(`[kaomoji-english-tutor] Sync poll failed: ${err}`);
			}
			pollTimer = setTimeout(tick, SYNC_POLL_MS);
			(pollTimer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll = true;
			pollTimer.unref?.();
		};
		pollTimer = setTimeout(tick, SYNC_POLL_MS);
		(pollTimer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll = true;
		pollTimer.unref?.();
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
		const width = Math.max(20, (process.stdout.columns || 120) - 2);
		const out = lines.flatMap((line) => wrapTextWithAnsi(line, width));
		ctx.ui.setWidget("kaomoji-english-tutor", out.map(accent), { placement: "belowEditor" });
	}

	/** Atomically select, mark, and activate the next due card. */
	function claimDueItem(now: Date): ItemRow | undefined {
		if (!db) return undefined;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			if (state.active_item_id != null || !pacingReady(state, now)) {
				db.exec("ROLLBACK");
				return undefined;
			}
			const due = getDueItem(db, now);
			if (!due) {
				db.exec("ROLLBACK");
				return undefined;
			}
			const isReview = due.shown === 1;
			if (!isReview) {
				markShown(db, due.id);
				touchStreak(db, now);
			}
			setRuntimeState(db, {
				active_item_id: due.id,
				active_kind: isReview ? "review" : "teach",
				active_version: state.active_version + 1,
				next_check_at: now.toISOString(),
			});
			db.exec("COMMIT");
			return db.prepare("SELECT * FROM items WHERE id = ?").get(due.id) as unknown as ItemRow | undefined;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[kaomoji-english-tutor] Due-card claim failed: ${err}`);
			return undefined;
		}
	}

	/** Render an item only when it is still the authoritative global card. */
	function showItem(ctx: ExtensionContext, item: ItemRow): boolean {
		if (!db) return false;
		const state = getRuntimeState(db);
		if (state.active_item_id !== item.id || !state.active_kind) return false;
		const isReview = state.active_kind === "review";
		pendingItemId = item.id;
		pendingFlipped = false;
		pendingIsReview = isReview;
		recordRendered(state);
		const face = isReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, isReview, face, false);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		if (config.verbose) {
			ctx.ui.notify(`${isReview ? "复习" : "新学"}：${item.text} — ${item.meaning}`, "info");
		}
		return true;
	}

	/** Populate the local projection when another session activated a card before this session observed it. */
	function hydratePending(ctx: ExtensionContext) {
		if (pendingItemId == null && db && getRuntimeState(db).active_item_id != null) {
			renderGlobalCard(ctx);
		}
	}

	/** Toggle the pending card between its question and answer sides. */
	function flipPending(ctx: ExtensionContext): boolean {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		const state = getRuntimeState(db);
		if (state.active_item_id !== pendingItemId || state.active_version !== localVersion) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return true;
		pendingFlipped = !pendingFlipped;
		const face = pendingIsReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, pendingIsReview, face, pendingFlipped);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		return true;
	}

	// -- Pet tick ---------------------------------------------------------

	/** Show the sentence card at a given level (0-based). */
	function showSentenceLevel(ctx: ExtensionContext, item: ItemRow, level: number) {
		const shown = { ...item, progress: level } as ItemRow;
		pendingFlipped = false;
		pendingIsReview = false;
		const lines = renderCard(shown, false, FACES.teach, false);
		lines.push(statsLine(db!));
		updateWidget(ctx, FACES.teach, lines);
	}

	/** Rate the pending review card; returns true once an action was taken (or a stale action was safely refreshed). */
	function ratePending(ctx: ExtensionContext, rating: Rating): boolean {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;

		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item || item.shown === 0) {
			pendingItemId = null;
			pendingFlipped = false;
			pendingIsReview = false;
			return true;
		}

		const now = new Date();
		const levels = parseJsonCol<string[]>(item.levels);
		const stateAtStart = getRuntimeState(db);
		// A stale rating (another session changed the global card) must not double-apply.
		if (stateAtStart.active_item_id !== item.id || stateAtStart.active_version !== localVersion) {
			pendingItemId = null;
			pendingFlipped = false;
			pendingIsReview = false;
			renderGlobalCard(ctx);
			return true;
		}

		// Good advances progressive sentence levels. Any Again immediately rates the whole card.
		if (item.type === "sentence" && levels && levels.length > 1) {
			const nextProgress = rating === Rating.Good && item.progress < levels.length - 1
				? item.progress + 1
				: null;
			if (nextProgress != null) {
				let applied = false;
				try {
					db.exec("BEGIN IMMEDIATE");
					const cur = getRuntimeState(db);
					const current = db.prepare("SELECT progress FROM items WHERE id = ?").get(item.id) as { progress: number } | undefined;
					if (cur.active_item_id === item.id && cur.active_version === stateAtStart.active_version && current?.progress === item.progress) {
						db.prepare("UPDATE items SET progress = ?, due_at = ? WHERE id = ?").run(nextProgress, now.toISOString(), item.id);
						setRuntimeState(db, {
							active_kind: "teach",
							active_version: cur.active_version + 1,
							next_check_at: now.toISOString(),
						});
						applied = true;
					}
					db.exec("COMMIT");
				} catch (err) {
					try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
					console.error(`[kaomoji-english-tutor] Sentence CAS failed: ${err}`);
				}
				if (!applied) {
					pendingItemId = null;
					pendingFlipped = false;
					pendingIsReview = false;
					renderGlobalCard(ctx);
					return true;
				}
				const state = getRuntimeState(db);
				recordRendered(state);
				const refreshed = db.prepare("SELECT * FROM items WHERE id = ?").get(item.id) as unknown as ItemRow;
				showSentenceLevel(ctx, refreshed, nextProgress);
				pendingItemId = item.id;
				pendingIsReview = false;
				return true;
			}
			// Full-level Good and any Again hand over to FSRS.
		}

		// Full rating: one-shot, atomic, applies at most once globally.
		const next = scheduleNext(item.fsrs_state, now, rating);
		const nextCheck = new Date(now.getTime() + intervalMs()).toISOString();
		let applied = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id === item.id && cur.active_version === stateAtStart.active_version) {
				if (item.type === "sentence" && rating === Rating.Again) {
					db.prepare("UPDATE items SET progress = 0 WHERE id = ?").run(item.id);
				}
				advanceReview(db, item.id, next.state, next.due, item.reviews + 1);
				bumpStat(db, "total_reviews", 1);
				touchStreak(db, now);
				setRuntimeState(db, {
					active_item_id: null,
					active_kind: null,
					active_version: cur.active_version + 1,
					next_check_at: nextCheck,
					coordinator: cur.coordinator,
					coordinator_until: cur.coordinator_until,
					last_activity: cur.last_activity,
				});
				applied = true;
			}
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			console.error(`[kaomoji-english-tutor] Rate CAS failed: ${err}`);
		} finally {
			pendingItemId = null;
			pendingFlipped = false;
			pendingIsReview = false;
		}

		if (!applied) {
			// Another session rated first; just refresh.
			renderGlobalCard(ctx);
			return true;
		}
		recordRendered(getRuntimeState(db));
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

	/** Atomically mark the pending card as well-known and enqueue its replacement. */
	function skipPending(ctx: ExtensionContext): ItemRow | undefined {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return undefined;
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return undefined;
		const now = new Date();
		const next = scheduleNext(item.fsrs_state, now, Rating.Easy);
		const minDue = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString();
		const due = next.due < minDue ? minDue : next.due;
		let applied = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id !== item.id || cur.active_version !== localVersion) {
				db.exec("ROLLBACK");
				renderGlobalCard(ctx);
				pendingItemId = null;
				pendingFlipped = false;
				pendingIsReview = false;
				return undefined;
			}
			db.prepare("UPDATE items SET status = 'mastered', fsrs_state = ?, due_at = ? WHERE id = ?").run(
				next.state,
				due,
				item.id,
			);
			bumpStat(db, "total_skipped", 1);
			enqueueReplacement(db, item.type);
			// Give this instance a short grace to generate the replacement without
			// another session surfacing a card in between.
			setRuntimeState(db, {
				active_item_id: null,
				active_kind: null,
				active_version: cur.active_version + 1,
				next_check_at: new Date(now.getTime() + REPLACEMENT_GRACE_MS).toISOString(),
				coordinator: myId,
				coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(),
				generation_token: null,
				generation_until: null,
				last_activity: now.toISOString(),
			});
			applied = true;
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			throw err;
		}

		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		if (applied) {
			recordRendered(getRuntimeState(db));
			updateWidget(ctx, FACES.party, [
				`${FACES.party} 好，${item.text} 记作很熟的内容，正在补充同类型卡片…`,
				statsLine(db),
			]);
			return item;
		}
		return undefined;
	}

	async function generateReplacementAndInsert(
		ctx: ExtensionContext,
		type: GeneratedItem["type"],
		skippedItem?: ItemRow,
	): Promise<boolean> {
		if (!db) return false;
		const skipped = skippedItem ?? latestMasteredItem(db, type);
		if (!skipped) {
			updateWidget(ctx, FACES.error, ["待补卡片缺少来源记录，请保留队列并稍后重试。", statsLine(db)]);
			return false;
		}
		const conversation = buildConversation(ctx.sessionManager.getBranch());
		if (!conversation.trim()) {
			updateWidget(ctx, FACES.idle, ["等会话形成明确话题后，再补充同类型卡片…", statsLine(db)]);
			return false;
		}
		const rejectionKey = `${type}\n${conversation}`;
		if (rejectionKey === lastRejectedReplacementKey) {
			updateWidget(ctx, FACES.idle, ["还在等待足够信息，以补充同类型卡片…", statsLine(db)]);
			return false;
		}
		const generationToken = claimGeneration();
		if (!generationToken) return false;

		const generation = sessionGeneration;
		pendingLLMCall = true;
		updateWidget(ctx, FACES.teach, ["正在补充同类型卡片，喵…"]);
		try {
			const resolved = resolveModel(ctx);
			if (!resolved) throw new Error("NO_MODEL");
			let decision: ReplacementDecision;
			try {
				decision = await generateReplacement(ctx, resolved, conversation, replacementKnownList(db), config, skipped);
			} catch (err) {
				if (!resolved.fromSession && ctx.model &&
					(ctx.model.provider !== resolved.provider || ctx.model.id !== resolved.model)) {
					if (sessionGeneration !== generation || !db) return false;
					decision = await generateReplacement(
						ctx,
						{ provider: ctx.model.provider, model: ctx.model.id, fromSession: true },
						conversation,
						replacementKnownList(db),
						config,
						skipped,
					);
				} else {
					throw err;
				}
			}
			if (sessionGeneration !== generation || !db) return false;
			if (buildConversation(ctx.sessionManager.getBranch()) !== conversation) return false;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
			if (!decision.ready) {
				lastRejectedReplacementKey = rejectionKey;
				updateWidget(ctx, FACES.idle, ["还在等待足够信息，以补充同类型卡片…", statsLine(db)]);
				if (config.verbose && decision.reason) ctx.ui.notify(`暂不补卡：${decision.reason}`, "info");
				return false;
			}

			const item = decision.item;
			const now = new Date();
			let inserted: ItemRow | undefined;
			let duplicate = false;
			db.exec("BEGIN IMMEDIATE");
			try {
				const state = getRuntimeState(db);
				if (!ownsGeneration(state, generationToken, now) || state.active_item_id != null || pendingReplacementTypes(db)[0] !== type) {
					db.exec("ROLLBACK");
					return false;
				}
				const dup = db.prepare(
					"SELECT COUNT(*) AS n FROM items WHERE type = ? AND lower(trim(text)) = lower(trim(?)) AND trim(meaning) = trim(?)",
				).get(item.type, item.text, item.meaning) as { n: number };
				if (Number(dup.n) > 0) {
					duplicate = true;
					db.exec("ROLLBACK");
				} else {
					const id = insertItem(db, item.type, item.text, item.phonetic || null, item.meaning, item.example || null, item.example_cn || null, now, {
						levels: item.levels,
						levels_cn: item.levels_cn,
						chunks: item.chunks,
						keyWords: item.keyWords,
					});
					insertCompanionWords(db, item.keyWords, now);
					bumpStat(db, "total_learned", 1);
					touchStreak(db, now);
					if (!consumeReplacement(db, type)) throw new Error("REPLACEMENT_QUEUE_MISMATCH");
					markShown(db, id);
					setRuntimeState(db, {
						active_item_id: id,
						active_kind: "teach",
						active_version: state.active_version + 1,
						next_check_at: now.toISOString(),
						generation_token: null,
						generation_until: null,
					});
					inserted = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
					if (!inserted) throw new Error("REPLACEMENT_INSERT_FAILED");
					db.exec("COMMIT");
				}
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				throw err;
			}
			if (duplicate) {
				lastRejectedReplacementKey = rejectionKey;
				updateWidget(ctx, FACES.idle, ["模型给出了重复内容，等话题变化后再补卡…", statsLine(db)]);
				return false;
			}
			lastRejectedReplacementKey = "";
			if (!inserted) return false;
			showItem(ctx, inserted);
			if (config.verbose) ctx.ui.notify(`已补充 ${TYPE_LABELS[type]}：${item.text}`, "info");
			return true;
		} catch (err) {
			if (sessionGeneration !== generation) return false;
			const msg = (err as Error)?.message || String(err);
			lastError = String((err as Error & { code?: string }).code || msg).slice(0, 80);
			if (db && !isCtxStale(ctx)) updateWidget(ctx, FACES.error, [`补卡失败：${lastError}`, statsLine(db)]);
			return false;
		} finally {
			if (db) releaseGeneration(generationToken);
			if (sessionGeneration === generation) pendingLLMCall = false;
		}
	}

	async function petTick(ctx: ExtensionContext) {
		const generation = sessionGeneration;
		if (isCtxStale(ctx)) return;
		if (!db) return;
		const now = new Date();
		const state0 = getRuntimeState(db);
		// A global card is active: render it and never swap it for another.
		if (state0.active_item_id != null) {
			renderGlobalCard(ctx);
			return;
		}

		// Respect the global pacing window so one session's rating cannot let
		// another session surface a different card ahead of the interval.
		if (!pacingReady(state0, now)) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
			return;
		}

		// A skipped card reserves one same-type replacement (priority over
		// surfacing when a session is actively generating it).
		const replacementType = pendingReplacementTypes(db)[0];
		let replacementWaiting = false;
		if (replacementType) {
			if (await generateReplacementAndInsert(ctx, replacementType)) return;
			if (sessionGeneration !== generation || !db) return;
			const state = getRuntimeState(db);
			const generationBusy = Boolean(
				state.generation_token && state.generation_until &&
				Date.now() < new Date(state.generation_until).getTime()
			);
			if (generationBusy) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
				return;
			}
			// Generation is waiting for better context; keep the FIFO obligation but
			// allow an already-due card to surface.
			resetPacing(db);
			replacementWaiting = true;
		}

		// 1. Due item first: select + mark + activate in one transaction.
		const due = claimDueItem(new Date());
		if (due) {
			if (!showItem(ctx, due)) renderGlobalCard(ctx);
			return;
		}
		if (getRuntimeState(db).active_item_id != null) {
			renderGlobalCard(ctx);
			return;
		}
		if (replacementWaiting) return;

		// 2. Otherwise teach new items (LLM), up to the daily limit, single-owner.
		if (countTodayNew(db, now) < config.dailyNewLimit) {
			if (pendingLLMCall) return;
			await generateAndInsert(ctx, now);
			return;
		}

		// 3. Nothing to do: the pet dozes off
		if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
	}

	async function generateAndInsert(ctx: ExtensionContext, _now: Date) {
		const conversation = buildConversation(ctx.sessionManager.getBranch());
		if (!conversation.trim()) {
			if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
			return;
		}
		if (conversation === lastRejectedConversation) {
			if (db) updateWidget(ctx, FACES.idle, ["还在观察话题，等信息更完整些…", statsLine(db)]);
			return;
		}
		const generationToken = claimGeneration();
		if (!generationToken) return;

		const generation = sessionGeneration;
		pendingLLMCall = true;
		if (db) updateWidget(ctx, FACES.teach, ["备课中，喵…"]);
		try {
			const resolved = resolveModel(ctx);
			if (!resolved) throw new Error("NO_MODEL");
			let decision: LessonDecision;
			try {
				decision = await generateLesson(ctx, resolved, conversation, db ? knownList(db) : [], config);
			} catch (err) {
				if (sessionGeneration !== generation) return;
				if (!resolved.fromSession && ctx.model &&
					(ctx.model.provider !== resolved.provider || ctx.model.id !== resolved.model)) {
					const fallback: ResolvedModel = {
						provider: ctx.model.provider,
						model: ctx.model.id,
						fromSession: true,
					};
					decision = await generateLesson(ctx, fallback, conversation, db ? knownList(db) : [], config);
					if (sessionGeneration !== generation) return;
					resolvedModelName = `${fallback.provider}/${fallback.model}（当前会话·降级）`;
				} else {
					throw err;
				}
			}
			if (sessionGeneration !== generation || !db ||
				buildConversation(ctx.sessionManager.getBranch()) !== conversation) return;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return;
			if (!decision.ready) {
				lastRejectedConversation = conversation;
				updateWidget(ctx, FACES.idle, ["还在观察话题，等信息更完整些…", statsLine(db)]);
				if (config.verbose && decision.reason) ctx.ui.notify(`暂不备课：${decision.reason}`, "info");
				return;
			}

			const lesson = decision;
			const insertedAt = new Date();
			let insertedFirst: ItemRow | undefined;
			db.exec("BEGIN IMMEDIATE");
			try {
				const state = getRuntimeState(db);
				if (!ownsGeneration(state, generationToken, insertedAt) ||
					state.active_item_id != null ||
					countTodayNew(db, insertedAt) >= config.dailyNewLimit ||
					pendingReplacementTypes(db).length > 0 ||
					getDueItem(db, insertedAt)) {
					db.exec("ROLLBACK");
					return;
				}
				let firstId: number | undefined;
				for (const it of lesson.items) {
					const id = insertItem(db, it.type, it.text, it.phonetic || null, it.meaning, it.example || null, it.example_cn || null, insertedAt, {
						levels: it.levels,
						levels_cn: it.levels_cn,
						chunks: it.chunks,
						keyWords: it.keyWords,
					});
					firstId ??= id;
					insertCompanionWords(db, it.keyWords, insertedAt);
				}
				if (firstId == null) throw new Error("LESSON_INSERT_FAILED");
				bumpStat(db, "total_learned", lesson.items.length);
				touchStreak(db, insertedAt);
				markShown(db, firstId);
				setRuntimeState(db, {
					active_item_id: firstId,
					active_kind: "teach",
					active_version: state.active_version + 1,
					next_check_at: insertedAt.toISOString(),
					generation_token: null,
					generation_until: null,
				});
				insertedFirst = db.prepare("SELECT * FROM items WHERE id = ?").get(firstId) as ItemRow | undefined;
				db.exec("COMMIT");
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				throw err;
			}
			lastRejectedConversation = "";
			if (!insertedFirst) return;
			showItem(ctx, insertedFirst);
			if (lesson.topic && db) {
				updateWidget(ctx, FACES.teach, [
					`${FACES.teach} 今日主题：${lesson.topic}`,
					...renderCard(insertedFirst, false, FACES.teach, false),
					statsLine(db),
				]);
			}
			if (config.verbose) {
				ctx.ui.notify(`备好课啦：${lesson.topic || "主题"}，共 ${lesson.items.length} 个学习项`, "info");
			}
		} catch (err) {
			if (sessionGeneration !== generation) return;
			const msg = (err as Error)?.message || String(err);
			lastError = String((err as Error & { code?: string }).code || msg).slice(0, 80);
			if (db) updateWidget(ctx, FACES.error, [`备课失败：${lastError}`]);
		} finally {
			if (db) releaseGeneration(generationToken);
			if (sessionGeneration === generation) pendingLLMCall = false;
		}
	}

	async function runSkipAction(ctx: ExtensionContext): Promise<void> {
		if (!db) {
			ctx.ui.notify("当前没有可跳过的卡片", "info");
			return;
		}
		const queueWasEmpty = pendingReplacementTypes(db).length === 0;
		let skipped: ItemRow | undefined;
		try {
			skipped = skipPending(ctx);
		} catch (err) {
			ctx.ui.notify(`标记失败：${(err as Error).message}`, "error");
			return;
		}
		if (!skipped || !db) {
			ctx.ui.notify("当前没有可跳过的卡片", "info");
			return;
		}
		const nextType = pendingReplacementTypes(db)[0];
		const source = queueWasEmpty && nextType === skipped.type ? skipped : undefined;
		const generation = sessionGeneration;
		const inserted = nextType ? await generateReplacementAndInsert(ctx, nextType, source) : false;
		if (sessionGeneration !== generation) return;
		if (!inserted && db) {
			// Generation failed or was waiting for info: lower the pacing window so
			// the next tick can surface a due card instead of stalling on the grace gap.
			resetPacing(db);
			scheduleTimer();
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

	pi.registerCommand("kaomoji:interval", {
		description: "Show/set the automatic lesson interval in minutes, or off",
		handler: async (args, ctx) => {
			const target = String(args ?? "").trim().toLowerCase();
			if (!target) {
				ctx.ui.notify(
					config.intervalMinutes > 0 ? `当前自动检查间隔：${config.intervalMinutes} 分钟` : "自动检查已关闭",
					"info",
				);
				ctx.ui.notify("用法：/kaomoji:interval <分钟|off>", "info");
				return;
			}
			if (target === "off") {
				config.intervalMinutes = 0;
				persistConfig({ intervalMinutes: 0 });
				stopTimer();
				ctx.ui.notify("自动检查已关闭", "info");
				return;
			}
			const minutes = Number(target);
			if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
				ctx.ui.notify("请输入大于 0 且不超过 1440 的分钟数，或 off", "error");
				return;
			}
			config.intervalMinutes = minutes;
			persistConfig({ intervalMinutes: minutes });
			scheduleTimer();
			ctx.ui.notify(`自动检查间隔已设为 ${minutes} 分钟（立即生效）`, "info");
		},
	});

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
		description: "Toggle the shown card between question and answer sides",
		handler: async (_args, ctx) => {
			if (!flipPending(ctx)) {
				ctx.ui.notify("当前没有可翻面的卡片", "info");
			}
		},
	});

	pi.registerCommand("kaomoji:good", {
		description: "Rate the pending review card as remembered (FSRS Good)",
		handler: async (_args, ctx) => {
			if (ratePending(ctx, Rating.Good)) {
				scheduleTimer();
			} else {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("kaomoji:again", {
		description: "Rate the pending review card as forgotten (FSRS Again)",
		handler: async (_args, ctx) => {
			if (ratePending(ctx, Rating.Again)) {
				scheduleTimer();
			} else {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("kaomoji:skip", {
		description: "Mark the shown card as known and generate a same-type replacement",
		handler: async (_args, ctx) => {
			await runSkipAction(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration++;
		stopTimer();
		lastDataVersion = null;
		localVersion = -1;
		releaseCoordinator();
		closeDb();
		config = loadConfig(ctx.cwd);
		resetState();
		latestCtx = ctx;
		// Establish my coordinator identity for the shared generation lease.
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
		} catch {
			sessionId = "";
		}
		myId = myCoordinatorId(sessionId, instanceToken);
		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		try {
			db = openDb();
		} catch (err) {
			console.error(`[kaomoji-english-tutor] Failed to open DB: ${err}`);
			db = null;
		}
		resolveModel(ctx);
		if (db) {
			ensureCoordinator(new Date(), true);
			// Rebuild the active global card so this session converges immediately.
			if (activeItem(db)) {
				renderGlobalCard(ctx);
			} else if (localVersion < 0) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
			}
			startPolling();
		}
		scheduleTimer();
	});

	pi.on("session_shutdown", async () => {
		sessionGeneration++;
		stopTimer();
		stopPolling();
		releaseCoordinator();
		latestCtx = undefined;
		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		pendingLLMCall = false;
		sessionId = "";
		myId = "";
		lastCoordinatorRenewal = 0;
		lastDataVersion = null;
		localVersion = -1;
		closeDb();
	});

	// Real user activity makes this the most-recent coordinator; injected input does not.
	pi.on("input", (event, _ctx) => {
		if (event.source !== "extension") ensureCoordinator(new Date(), true);
		return { action: "continue" };
	});

}
