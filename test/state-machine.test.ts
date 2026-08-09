import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { visibleWidth } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-tutor-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../index.ts");
let sessionSeq = 0;

interface FakeTimer {
	callback: () => void;
	delay: number;
	active: boolean;
	unref(): void;
}

function installFakeTimers() {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	let timers: FakeTimer[] = [];
	(globalThis as any).setTimeout = (callback: () => void, delay = 0) => {
		const timer: FakeTimer = { callback, delay, active: true, unref() {} };
		timers.push(timer);
		return timer;
	};
	(globalThis as any).clearTimeout = (timer: FakeTimer) => { timer.active = false; };

	const kaomojiPoll = (timer: FakeTimer) => (timer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll;
	return {
		/** Active timers that are NOT the kaomoji cross-session sync poll. */
		active: () => timers.filter((timer) => timer.active && !kaomojiPoll(timer)),
		/** Active cross-session sync poll timers. */
		poll: () => timers.filter((timer) => timer.active && kaomojiPoll(timer)),
		reset: () => { timers = []; },
		async fire(timer?: FakeTimer) {
			// By default fire the first active work timer (skipping the sync poll).
			const target = timer ?? timers.find((entry) => entry.active && !kaomojiPoll(entry));
			assert.ok(target, "expected an active timer");
			target.active = false;
			target.callback();
			await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
		},
		async firePoll() {
			// Fire every currently-active sync poll (one per attached session).
			const targets = timers.filter((entry) => entry.active && kaomojiPoll(entry));
			assert.ok(targets.length > 0, "expected an active poll timer");
			for (const target of targets) {
				target.active = false;
				target.callback();
			}
			await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
		},
		flush: () => new Promise<void>((resolve) => realSetTimeout(resolve, 0)),
		restore() {
			(globalThis as any).setTimeout = realSetTimeout;
			(globalThis as any).clearTimeout = realClearTimeout;
		},
	};
}

async function createHarness(options: { model?: any; modelRegistry?: any; sessionId?: string } = {}) {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify({ intervalMinutes: 10, dailyNewLimit: 0 }));
	return makeSession(options);
}

/** Configure a clean shared agentDir (used once before attaching multi-session variants). */
function writeConfig(config: Record<string, unknown>) {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify(config));
}

/** Attach one extension instance to the shared agentDir (a single Pi session/process). */
async function makeSession(options: { model?: any; modelRegistry?: any; sessionId?: string } = {}) {
	const logicalSessionId = options.sessionId ?? `session-${++sessionSeq}`;
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const shortcuts: Record<string, any> = {};
	let widget: string[] = [];
	const customState: { calls: number; doneCalls: number; options?: any; panel?: any } = { calls: 0, doneCalls: 0 };
	const pi: any = {
		getSessionName: () => "",
		setSessionName: () => {},
		registerCommand: (name: string, options: any) => { commands[name] = options; },
		registerShortcut: (key: string, options: any) => { shortcuts[key] = options; },
		on: (name: string, handler: any) => { handlers[name] = handler; },
	};
	const ctx: any = {
		cwd: "/tmp",
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		model: options.model,
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => { widget = lines ?? []; },
			notify: () => {},
			theme: { fg: (_token: string, text: string) => text },
			custom: (factory: any, options?: any) => {
				customState.calls++;
				customState.options = options;
				return new Promise((resolve) => {
					let done = false;
					const finish = (result: any) => {
						if (done) return;
						done = true;
						customState.doneCalls++;
						resolve(result);
					};
					customState.panel = factory(
						{ requestRender: () => {} },
						{ fg: (_token: string, text: string) => text },
						{},
						finish,
					);
				});
			},
		},
		sessionManager: {
			getSessionId: () => logicalSessionId,
			getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "timer cleanup" }] } }],
		},
		modelRegistry: options.modelRegistry ?? { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
	};
	await (extension as any)(pi);
	await handlers.session_start({ reason: "startup" }, ctx);
	return { handlers, commands, shortcuts, ctx, widget: () => widget, customState };
}

function openTestDb() {
	return new DatabaseSync(`${agentDir}/kaomoji-english-tutor.db`);
}

function insertSentence(db: DatabaseSync) {
	const levels = [
		"The extension clears resources.",
		"The extension clears resources during shutdown.",
		"Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.",
	];
	db.prepare(
		"INSERT INTO items(type,text,meaning,learned_at,due_at,levels,levels_cn,chunks,key_words) VALUES('sentence',?,?,?,?,?,?,?,?)",
	).run(
		levels[2],
		"完整翻译",
		new Date().toISOString(),
		new Date(0).toISOString(),
		JSON.stringify(levels),
		JSON.stringify(["一级", "二级", "三级"]),
		JSON.stringify(["Because the extension", "owns resources", "during shutdown"]),
		JSON.stringify([{ text: "runtime", meaning: "运行时" }, { text: "callback", meaning: "回调" }]),
	);
}

test("time-only lifecycle pauses for pending cards and restarts after rating", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		assert.equal(harness.handlers.agent_end, undefined);
		assert.equal(fake.active().length, 1);
		assert.equal(fake.active()[0].delay, 600_000);
		assert.equal(fake.poll().length, 1);
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /timer/);
		assert.match(harness.widget().join(" "), /今日新增 1/);
		assert.equal(fake.active().length, 0);
		const check = openTestDb();
		const shown = check.prepare("SELECT shown,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...shown }, { shown: 1, reviews: 0, fsrs_state: "" });
		await harness.commands["kaomoji:good"].handler("", harness.ctx);
		assert.equal(fake.active().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		assert.equal(fake.active().length, 0);
		assert.equal(fake.poll().length, 0);
	} finally {
		fake.restore();
	}
});

test("progressive Good/Again transitions touch FSRS only at boundaries", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		for (const action of ["good", "again", "good"] as const) {
			await harness.commands[`kaomoji:${action}`].handler("", harness.ctx);
		}
		let check = openTestDb();
		let row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 1, reviews: 0, fsrs_state: "" });
		for (const action of ["good", "good"] as const) {
			await harness.commands[`kaomoji:${action}`].handler("", harness.ctx);
		}
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.equal(row.progress, 2);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("consecutive skips preserve FIFO replacement obligations", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		const insert = db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES(?,?,?,?,?)");
		insert.run("word", "timer", "定时器", new Date().toISOString(), new Date(0).toISOString());
		insert.run("phrase", "clear a timer", "清除定时器", new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["kaomoji:skip"].handler("", harness.ctx);
		await fake.fire();
		assert.match(harness.widget().join(" "), /clear a timer/);
		await harness.commands["kaomoji:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const raw = (check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value;
		const statuses = check.prepare("SELECT status FROM items ORDER BY id").all() as Array<{ status: string }>;
		check.close();
		assert.deepEqual(JSON.parse(raw), ["word", "phrase"]);
		assert.deepEqual(statuses.map((row) => row.status), ["mastered", "mastered"]);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("skip mastering rolls back when replacement enqueue fails", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.exec(`
			CREATE TRIGGER reject_replacement_queue
			BEFORE INSERT ON stats
			WHEN NEW.key = 'pending_replacements'
			BEGIN
				SELECT RAISE(ABORT, 'queue write failed');
			END;
		`);
		db.close();
		await fake.fire();
		await harness.commands["kaomoji:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT status,fsrs_state FROM items WHERE id=1").get() as any;
		const skippedStat = check.prepare("SELECT value FROM stats WHERE key='total_skipped'").get();
		check.close();
		assert.equal(item.status, "learning");
		assert.equal(item.fsrs_state, "");
		assert.equal(skippedStat, undefined);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("stale replacement completion cannot mutate a new session", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		let resolveAuth!: (value: { ok: false; error: string }) => void;
		const auth = new Promise<{ ok: false; error: string }>((resolve) => { resolveAuth = resolve; });
		let authStarted = false;
		const model = { provider: "fake", id: "deepseek-v4-flash" };
		const modelRegistry = {
			getAvailable: () => [model],
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: () => { authStarted = true; return auth; },
		};
		const harness = await createHarness({ model, modelRegistry });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,status) VALUES('word','old','旧词',?,?,1,'mastered')")
			.run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('phrase','new session card','新会话卡片',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		db.close();
		await fake.fire();
		assert.equal(authStarted, true);
		await harness.handlers.session_shutdown({ reason: "reload" }, harness.ctx);
		await harness.handlers.session_start({ reason: "reload" }, harness.ctx);
		assert.equal(fake.active().length, 1);
		resolveAuth({ ok: false, error: "cancelled old session" });
		await fake.flush();
		await fake.flush();
		const check = openTestDb();
		const due = check.prepare("SELECT shown FROM items WHERE id=2").get() as any;
		check.close();
		assert.equal(due.shown, 0);
		assert.equal(fake.active().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});


test("Control+Option+K registers and guards unavailable panel contexts", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const shortcut = harness.shortcuts["ctrl+alt+k"];
		assert.equal(typeof shortcut?.handler, "function");
		await shortcut.handler(harness.ctx);
		assert.equal(harness.customState.calls, 0);

		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		harness.ctx.mode = "rpc";
		await shortcut.handler(harness.ctx);
		assert.equal(harness.customState.calls, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("review panel flips and handles Kitty Good/Again while preserving sentence state", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		insertSentence(db);
		db.close();
		await fake.fire();
		const panelPromise = harness.shortcuts["ctrl+alt+k"].handler(harness.ctx);
		const panel = harness.customState.panel;
		assert.equal(harness.customState.options?.overlay, undefined);
		assert.ok(panel.render(8).every((line: string) => visibleWidth(line) <= 8));
		panel.handleInput(" ");
		assert.match(panel.render(120).join(" "), /翻译/);

		panel.handleInput("\x1b[103u");
		panel.handleInput("\x1b[97u");
		let check = openTestDb();
		const row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 0, reviews: 0, fsrs_state: "" });
		assert.equal(harness.customState.doneCalls, 0);

		panel.handleInput("\x1b");
		await panelPromise;
		assert.equal(fake.active().length, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("review panel clears failed opens, suppresses duplicates, and resumes after Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		const shortcut = harness.shortcuts["ctrl+alt+k"];
		const custom = harness.ctx.ui.custom;
		harness.ctx.ui.custom = () => Promise.reject(new Error("custom failed"));
		await assert.rejects(shortcut.handler(harness.ctx), /custom failed/);
		harness.ctx.ui.custom = custom;

		const panelPromise = shortcut.handler(harness.ctx);
		await shortcut.handler(harness.ctx);
		assert.equal(harness.customState.calls, 1);
		harness.customState.panel.handleInput("\x1b[103u");
		await panelPromise;
		assert.equal(harness.customState.doneCalls, 1);
		assert.equal(fake.active().length, 1);
		const check = openTestDb();
		const row = check.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("review panel Skip closes, masters the card, and preserves replacement work", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		const panelPromise = harness.shortcuts["ctrl+alt+k"].handler(harness.ctx);
		harness.customState.panel.handleInput("\x1b[115u");
		await panelPromise;
		await fake.flush();
		const check = openTestDb();
		const item = check.prepare("SELECT status FROM items WHERE id=1").get() as any;
		const queue = check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any;
		check.close();
		assert.equal(item.status, "mastered");
		assert.deepEqual(JSON.parse(queue.value), ["word"]);
		assert.doesNotMatch(harness.widget().join(" "), /已会/);
		assert.equal(fake.active().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("review panel shutdown resolves an open panel", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		const panelPromise = harness.shortcuts["ctrl+alt+k"].handler(harness.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		await panelPromise;
		assert.equal(harness.customState.doneCalls, 1);
	} finally {
		fake.restore();
	}
});

// -- Multi-session consistency ------------------------------------------

function insertDueWord(db: DatabaseSync, text: string, meaning: string) {
	db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word',?,?,?,?)")
		.run(text, meaning, new Date().toISOString(), new Date(0).toISOString());
}

function lessonResponse(topic = "concurrency") {
	const sentence = "Because several sessions share one database, each action must be committed exactly once before every widget refreshes.";
	return JSON.stringify({
		ready: true,
		topic,
		items: [
			{ type: "word", text: "coordinate", phonetic: "/koʊˈɔːrdɪneɪt/", meaning: "协调", example: "We coordinate shared work.", example_cn: "我们协调共享工作。" },
			{ type: "phrase", text: "single source of truth", phonetic: "", meaning: "唯一事实来源", example: "SQLite is the single source of truth.", example_cn: "SQLite 是唯一事实来源。" },
			{
				type: "sentence", text: sentence, phonetic: "", meaning: "因为多个会话共享同一个数据库，所以每个操作都必须只提交一次，然后所有组件再刷新。", example: "", example_cn: "",
				levels: ["Each action must be committed.", "Each action must be committed exactly once before every widget refreshes.", sentence],
				levels_cn: ["每个操作都必须提交。", "每个操作都必须只提交一次，然后所有组件再刷新。", "因为多个会话共享同一个数据库，所以每个操作都必须只提交一次，然后所有组件再刷新。"],
				chunks: ["Because several sessions share one database", "each action must be committed exactly once", "before every widget refreshes"],
				keyWords: [{ text: "commit", phonetic: "/kəˈmɪt/", meaning: "提交" }, { text: "refresh", phonetic: "/rɪˈfreʃ/", meaning: "刷新" }],
			},
		],
	});
}

function fauxModelRegistry(registration: ReturnType<typeof registerFauxProvider>) {
	const model = registration.getModel();
	return {
		model,
		registry: {
			getAvailable: () => [model],
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	};
}

test("two sessions share one global card and rate it at most once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession();
		const b = await makeSession();
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();

		// Session A surfaces the due card and claims the global slot.
		await fake.fire();
		assert.match(a.widget().join(" "), /timer/);
		// Session B's timer renders the *same* global card, not a second one.
		await fake.fire();
		assert.match(b.widget().join(" "), /timer/);

		const check = openTestDb();
		const active = check.prepare("SELECT active_item_id, active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(active.active_item_id, 1);
		assert.equal(active.active_kind, "teach");

		// Both sessions attempt to rate the same card; only one applies.
		await a.commands["kaomoji:good"].handler("", a.ctx);
		await b.commands["kaomoji:good"].handler("", b.ctx);

		const fin = openTestDb();
		const row = fin.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const cleared = fin.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		fin.close();
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(cleared.active_item_id, null);

		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("session B auto-refreshes when session A rates the shared card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession();
		const b = await makeSession();
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();

		await fake.fire(); // A claims + shows the card
		await fake.fire(); // B renders the same card
		assert.match(b.widget().join(" "), /timer/);

		// Let B's poll observe the active card once so it can later detect changes.
		await fake.firePoll();

		// A rates Good, clearing the global slot.
		await a.commands["kaomoji:good"].handler("", a.ctx);
		assert.match(a.widget().join(" "), /记牢了/);

		// B's poll notices the data_version change and drops the pending card.
		await fake.firePoll();
		assert.doesNotMatch(b.widget().join(" "), /timer/);

		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("session shutdown keeps the shared global card for other sessions", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession();
		const b = await makeSession();
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();

		await fake.fire(); // A claims + shows the card
		await fake.fire(); // B renders the same card

		// A's session ends (like a crash or /reload); the global card must persist.
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await fake.firePoll(); // B's poll re-reads the (unchanged) global card
		assert.match(b.widget().join(" "), /timer/);

		// B can still operate on it, applying the rating exactly once.
		await b.commands["kaomoji:good"].handler("", b.ctx);
		const fin = openTestDb();
		const row = fin.prepare("SELECT reviews FROM items WHERE id=1").get() as any;
		fin.close();
		assert.equal(row.reviews, 1);

		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("stale cross-session sentence and Skip actions apply exactly once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "sentence-a" });
		const b = await makeSession({ sessionId: "sentence-b" });
		let db = openTestDb();
		insertSentence(db);
		db.close();
		await fake.fire();
		await fake.fire();
		await a.commands["kaomoji:good"].handler("", a.ctx);
		await b.commands["kaomoji:good"].handler("", b.ctx);
		db = openTestDb();
		const sentence = db.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		db.close();
		assert.deepEqual({ ...sentence }, { progress: 1, reviews: 0 });
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);

		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const c = await makeSession({ sessionId: "skip-a" });
		const d = await makeSession({ sessionId: "skip-b" });
		db = openTestDb();
		insertDueWord(db, "known", "已知");
		db.close();
		await fake.fire();
		await fake.fire();
		await c.commands["kaomoji:skip"].handler("", c.ctx);
		await d.commands["kaomoji:skip"].handler("", d.ctx);
		db = openTestDb();
		const queue = JSON.parse((db.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value);
		const skipped = Number((db.prepare("SELECT value FROM stats WHERE key='total_skipped'").get() as any).value);
		db.close();
		assert.deepEqual(queue, ["word"]);
		assert.equal(skipped, 1);
		await c.handlers.session_shutdown({ reason: "quit" }, c.ctx);
		await d.handlers.session_shutdown({ reason: "quit" }, d.ctx);
	} finally {
		fake.restore();
	}
});

test("external rating closes a stale review panel", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "panel-a" });
		const b = await makeSession({ sessionId: "panel-b" });
		const db = openTestDb();
		insertDueWord(db, "shared", "共享");
		db.close();
		await fake.fire();
		await fake.fire();
		const panelPromise = b.shortcuts["ctrl+alt+k"].handler(b.ctx);
		assert.equal(b.customState.doneCalls, 0);
		await a.commands["kaomoji:good"].handler("", a.ctx);
		await fake.firePoll();
		await panelPromise;
		assert.equal(b.customState.doneCalls, 1);
		assert.doesNotMatch(b.widget().join(" "), /shared/);
		assert.equal(fake.active().length, 2);
		assert.ok(fake.active().every((timer) => timer.delay > 500_000));
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("coordinator follows recent input and recovers after shutdown or expiry", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ sessionId: "leader-a" });
		const b = await makeSession({ sessionId: "leader-b" });
		let db = openTestDb();
		let coordinator = String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator);
		db.close();
		assert.match(coordinator, /^leader-b::/);

		a.handlers.input({ type: "input", text: "hello", source: "interactive" }, a.ctx);
		db = openTestDb();
		coordinator = String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator);
		db.close();
		assert.match(coordinator, /^leader-a::/);
		b.handlers.input({ type: "input", text: "injected", source: "extension" }, b.ctx);
		db = openTestDb();
		assert.equal(String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator), coordinator);
		db.close();

		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		db = openTestDb();
		assert.equal((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator, null);
		db.prepare("UPDATE runtime_state SET coordinator='dead', coordinator_until=?, generation_token='stale' WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		db = openTestDb();
		coordinator = String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator);
		db.close();
		assert.match(coordinator, /^leader-b::/);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
		assert.equal(fake.active().length, 0);
		assert.equal(fake.poll().length, 0);
	} finally {
		fake.restore();
	}
});

test("single coordinator commits one lesson batch", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-faux" });
	try {
		registration.setResponses([fauxAssistantMessage(lessonResponse())]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "lesson-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "lesson-b" });
		await fake.fire();
		await fake.fire();
		await fake.flush();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(registration.state.callCount, 1);
		assert.equal(count, 5);
		assert.equal(state.active_item_id, 1);
		assert.equal(state.active_kind, "teach");
		await fake.firePoll();
		assert.match(a.widget().join(" "), /coordinate/);
		assert.match(b.widget().join(" "), /coordinate/);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("leadership change discards an in-flight stale lesson", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-stale-faux" });
	try {
		let resolveLesson!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		registration.setResponses([
			() => new Promise((resolve) => { resolveLesson = resolve; }),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "stale-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "stale-b" });
		await fake.fire(); // non-coordinator A cannot start generation
		await fake.fire(); // coordinator B starts the deferred LLM call
		assert.equal(registration.state.callCount, 1);
		a.handlers.input({ type: "input", text: "newer context", source: "interactive" }, a.ctx);
		resolveLesson(fauxAssistantMessage(lessonResponse("stale")));
		await fake.flush();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT coordinator,generation_token,active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(count, 0);
		assert.match(String(state.coordinator), /^stale-a::/);
		assert.equal(state.generation_token, null);
		assert.equal(state.active_item_id, null);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});



test.after(() => rmSync(agentDir, { recursive: true, force: true }));
