import { existsSync, readFileSync } from "node:fs";
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
	maxTokens: 600,
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
			reviews INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS stats (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
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
) {
	db.prepare(
		"INSERT INTO items (type, text, phonetic, meaning, example, example_cn, learned_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(type, text, phonetic, meaning, example, example_cn, now.toISOString(), now.toISOString());
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
 * Advance a card with a Good rating (display-based review, no user feedback).
 * Passing null state creates the first schedule for a brand-new item.
 */
function scheduleNext(stateJson: string | null, now: Date): { state: string; due: string } {
	const card = stateJson ? restoreCard(stateJson) : new Card();
	const info = scheduler.repeat(card, now)[Rating.Good];
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

	return { topic: String(parsed.topic ?? ""), items };
}

// -- Widget rendering -----------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
	word: "单词",
	phrase: "词组",
	sentence: "句子",
};

function statsLine(db: DatabaseSync): string {
	const total = Number(
		(db.prepare("SELECT COUNT(*) AS n FROM items WHERE shown = 1").get() as { n: number }).n,
	);
	const todayReviews = countTodayReviews(db, new Date());
	const streak = Number(getStat(db, "streak_days") ?? 0);
	return `📚 已学 ${total} · 今日复习 ${todayReviews} · 连续学习 ${streak} 天`;
}

/** Render a teach/review card as widget lines. */
function renderCard(item: ItemRow, isReview: boolean, face: string, nextDue?: string): string[] {
	const label = TYPE_LABELS[item.type] ?? item.type;
	const lines: string[] = [];
	if (isReview) {
		lines.push(`${face} 复习时间到：${item.text}${item.phonetic ? " " + item.phonetic : ""} — ${item.meaning}`);
		lines.push(`  第 ${item.reviews + 1} 次复习，下次 ${(nextDue ?? item.due_at).slice(0, 10)}`);
	} else {
		lines.push(`${face} ${label}：${item.text}${item.phonetic ? " / " + item.phonetic : ""}`);
		lines.push(`  释义：${item.meaning}`);
	}
	if (item.example) {
		lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
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
		const lines = renderCard(item, isReview, face, nextDue);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		if (config.verbose) {
			ctx.ui.notify(`${isReview ? "复习" : "新学"}：${item.text} — ${item.meaning}`, "info");
		}
	}

	// -- Pet tick ---------------------------------------------------------

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
				showItem(ctx, due, false);
			} else {
				const next = scheduleNext(due.fsrs_state, now);
				advanceReview(db, due.id, next.state, next.due, due.reviews + 1);
				bumpStat(db, "total_reviews", 1);
				touchStreak(db, now);
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
			if (!conversation.trim()) return;

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
				insertItem(db, it.type, it.text, it.phonetic || null, it.meaning, it.example || null, it.example_cn || null, now);
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

	// -- Event handlers ---------------------------------------------------

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
