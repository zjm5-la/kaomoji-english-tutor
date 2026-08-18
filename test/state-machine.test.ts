import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider, streamSimple as streamModel } from "@earendil-works/pi-ai/compat";

const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-tutor-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sdkRuntimeFactory = async (ctx: any) => ({
	getModel: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
	hasConfiguredAuth: () => true,
	setRuntimeApiKey: async () => {},
	streamSimple: async (model: any, context: any, options: any) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) throw new Error("NO_API_KEY");
		return streamModel(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
	},
}) as any;
const { default: extension, contentFingerprint } = await import("../index.ts");
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
	const realRandom = Math.random;
	Math.random = () => 0; // deterministic: review direction always "forward" unless a test overrides
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
			Math.random = realRandom;
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
	const notifications: string[] = [];
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
			notify: (message: unknown) => { notifications.push(String(message)); },
			theme: { fg: (_token: string, text: string) => text },
		},
		sessionManager: {
			getSessionId: () => logicalSessionId,
			getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "timer cleanup" }] } }],
		},
		modelRegistry: options.modelRegistry ?? { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
	};
	await (extension as any)(pi, { runtimeFactory: sdkRuntimeFactory });
	await handlers.session_start({ reason: "startup" }, ctx);
	return { handlers, commands, shortcuts, ctx, widget: () => widget, notifications: () => notifications };
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
		assert.match(harness.widget().join(" "), /连续学习 1 天.*今日剩余卡片（复习 1）/);
		assert.match(harness.widget().join(" "), /\/anki:flip/);
		assert.equal(harness.shortcuts["ctrl+alt+k"], undefined);
		assert.equal(fake.active().length, 0);
		const check = openTestDb();
		const shown = check.prepare("SELECT shown,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...shown }, { shown: 1, reviews: 0, fsrs_state: "" });
		await harness.commands["anki:good"].handler("", harness.ctx);
		assert.equal(fake.active().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		assert.equal(fake.active().length, 0);
		assert.equal(fake.poll().length, 0);
	} finally {
		fake.restore();
	}
});

test("answer on a newly taught word does not grade the visible English prompt", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-new-word-answer" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ verdict: "incorrect", feedback: "Expected the English word." })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "new-word-answer" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','condition','（判断）条件',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /单词：condition/, "new-card face already shows the English word");
		await harness.commands["anki:answer"].handler("条件", harness.ctx);
		assert.ok(harness.notifications().some((message) => /新卡.*翻面/.test(message)), "answer explains the new-card interaction");
		const check = openTestDb();
		const item = check.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id=1").get() as any).n);
		const state = check.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { reviews: 0, fsrs_state: "" });
		assert.equal(attempts, 0, "new-card answer creates no authoritative attempt");
		assert.deepEqual({ ...state }, { active_item_id: 1, active_kind: "teach" }, "new card stays active");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("progressive sentence requires written output and touches FSRS only after L3", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /句子输出（L1\/3）/);
		await harness.commands["anki:good"].handler("", harness.ctx);
		let check = openTestDb();
		let row = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 0, reviews: 0 }, "manual Good cannot bypass sentence output");

		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension clears resources during shutdown.", harness.ctx);
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 2, reviews: 0, fsrs_state: "" });

		await harness.commands["anki:answer"].handler("Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.", harness.ctx);
		assert.match(harness.widget().join(" "), /独立写对了/);
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id=1").get() as any).n);
		check.close();
		assert.equal(row.progress, 2);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(attempts, 3);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("manual Again ends sentence output once and resets it to L1", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension clears resources during shutdown.", harness.ctx);
		assert.match(harness.widget().join(" "), /L3\/3/);

		await harness.commands["anki:again"].handler("", harness.ctx);

		const check = openTestDb();
		const row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const runtime = check.prepare("SELECT active_item_id,active_review_cycle_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(row.progress, 0);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(runtime.active_item_id, null);
		assert.equal(runtime.active_review_cycle_id, null);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("sentence correction retries stay on the level and final FSRS uses the first recall", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-sentence-eval-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				verdict: "partial",
				feedback: "主谓一致需要 clears",
				errorTags: ["grammar"],
				correctedAnswer: "The extension clears resources during shutdown.",
			})),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "sentence-retry" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension clear resources during shutdown.", harness.ctx);
		assert.match(harness.widget().join(" "), /差一点.*主谓一致/);
		const reattached = await makeSession({ model, modelRegistry: registry, sessionId: "sentence-retry-reattached" });
		assert.match(reattached.widget().join(" "), /差一点.*主谓一致/, "SQLite reattachment preserves corrective teaching");

		let check = openTestDb();
		let state = check.prepare("SELECT active_cycle_outcome,active_retry_count,active_assistance_level FROM runtime_state WHERE id=1").get() as any;
		let row = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 1, reviews: 0 });
		assert.deepEqual({ ...state }, { active_cycle_outcome: "again", active_retry_count: 1, active_assistance_level: "hint" });

		await harness.commands["anki:answer"].handler("The extension clears resources during shutdown.", harness.ctx);
		await harness.commands["anki:answer"].handler("Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.", harness.ctx);
		assert.match(harness.widget().join(" "), /首次回忆有辅助或错误/);
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = check.prepare("SELECT verdict,explicit_rating,assistance_level,error_tags_json FROM attempts WHERE item_id=1 ORDER BY started_at,id").all() as any[];
		state = check.prepare("SELECT active_item_id,active_review_cycle_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(row.progress, 0);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(attempts.length, 4);
		assert.equal(attempts.filter((attempt) => attempt.explicit_rating === "again").length, 1);
		assert.ok(attempts.some((attempt) => attempt.verdict === "partial" && /grammar/.test(attempt.error_tags_json)));
		assert.deepEqual({ ...state }, { active_item_id: null, active_review_cycle_id: null });
		await reattached.handlers.session_shutdown({ reason: "quit" }, reattached.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("answer shows a thinking animation while sentence evaluation is pending", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-answer-thinking" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({
					verdict: "correct",
					feedback: "",
					errorTags: [],
					correctedAnswer: "The extension clears resources during shutdown.",
				}));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "answer-thinking" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		const inFlight = harness.commands["anki:answer"].handler("The extension cleans resources during shutdown.", harness.ctx);
		await started;
		assert.match(harness.widget().join(" "), /⠋ 正在判断你的答案/);
		releaseResponse();
		await inFlight;
		assert.doesNotMatch(harness.widget().join(" "), /正在判断你的答案/, "animation stops after evaluation");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("answer judging keeps the card visible and ignores cross-session repaints", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-answer-flicker" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "partial", feedback: "拼写差一点" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "answer-flicker" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','condition','（判断）条件',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire(); // claim + render the review question
		const cardLines = harness.widget();
		assert.match(cardLines.join(" "), /复习时间到/);
		const inFlight = harness.commands["anki:answer"].handler("conditon", harness.ctx);
		await started;
		const judging = harness.widget();
		assert.match(judging.join(" "), /正在判断你的答案/);
		assert.equal(judging.length, cardLines.length + 1, "spinner overlays the card instead of replacing it");
		for (const line of cardLines) assert.ok(judging.includes(line), `card line preserved during judging: ${line}`);
		// Another session commits to the shared DB; the sync poll must not repaint over the animation.
		const external = openTestDb();
		external.prepare("UPDATE items SET learned_at = learned_at WHERE id = 1").run();
		external.close();
		await fake.firePoll();
		const afterPoll = harness.widget();
		assert.equal(afterPoll.length, judging.length, "poll repaint cannot change widget height during judging");
		assert.match(afterPoll.join(" "), /正在判断你的答案/);
		releaseResponse();
		await inFlight;
		assert.doesNotMatch(harness.widget().join(" "), /正在判断你的答案/, "animation stops after evaluation");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

function insertClozeCard(db: DatabaseSync, shown: 0 | 1 = 0) {
	db.prepare(
		"INSERT INTO items(type,text,phonetic,meaning,example,example_cn,chunks,learned_at,due_at,shown) VALUES('cloze',?,NULL,?,?,?,?,?,?,?)",
	).run(
		"The fix that ___ (commit) this morning won't take effect until you reload.",
		"was committed",
		"The fix that was committed this morning won't take effect until you reload.",
		"今早提交的修复要等你重载后才生效。（考点：that 从句修饰单数主语 document，需用 was committed）",
		JSON.stringify(["The fix", "that was committed this morning", "won't take effect", "until you reload"]),
		new Date().toISOString(),
		new Date(0).toISOString(),
		shown,
	);
}

function makeClozeDue() {
	const db = openTestDb();
	db.prepare("UPDATE items SET due_at = ? WHERE type = 'cloze'").run(new Date(0).toISOString());
	db.prepare("UPDATE runtime_state SET next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
	db.close();
}

test("cloze lifecycle: teach face, review answer, exact match, and LLM partial", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-cloze-life" });
	try {
		// One evaluator call for the near-miss answer at the end of the test.
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ verdict: "partial", feedback: "少了 was：应为被动语态。" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "cloze-life" });
		const db = openTestDb();
		insertClozeCard(db);
		db.close();
		await fake.fire();
		// First showing is already the quiz face: blank + lemma hint, no answer,
		// no Chinese gloss/grammar note (they would name the answer form).
		const first = harness.widget().join(" ");
		assert.match(first, /语法填空/);
		assert.match(first, /The fix that ___ \(commit\) this morning/);
		assert.doesNotMatch(first, /was committed/, "first showing must not leak the answer");
		assert.doesNotMatch(first, /句意|考点/, "first showing hides the gloss and grammar note");
		// First attempt is graded immediately (exact local match -> Good).
		await harness.commands["anki:answer"].handler("was committed", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		let check = openTestDb();
		const afterFirst = check.prepare("SELECT reviews, due_at FROM items WHERE id = 1").get() as any;
		const directions = (check.prepare("SELECT COUNT(*) AS n FROM direction_state WHERE item_id = 1").get() as any).n;
		check.close();
		assert.equal(afterFirst.reviews, 1, "first attempt rates the card once");
		assert.ok(new Date(afterFirst.due_at).getTime() > Date.now(), "rated into the future");
		assert.equal(directions, 0, "cloze keeps a single-direction FSRS state");

		// Review question face: only the blanked sentence; the Chinese gloss and
		// grammar note (which can name the answer form) stay on the answer face.
		makeClozeDue();
		await fake.fire();
		const review = harness.widget().join(" ");
		assert.match(review, /___/);
		assert.doesNotMatch(review, /句意|考点/, "question face shows no Chinese gloss or grammar note");
		assert.doesNotMatch(review, /was committed/, "review face must not leak the answer");
		// Hint masks the answer with first letters and word lengths.
		await harness.commands["anki:hint"].handler("", harness.ctx);
		assert.ok(harness.notifications().some((message) => /提示：w__ c_{8}/.test(message)), "hint masks the answer");
		// Exact local match (case/punctuation tolerant) skips the LLM entirely.
		await harness.commands["anki:answer"].handler("Was  COMMITTED.", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		check = openTestDb();
		const exact = check.prepare("SELECT verdict, kind, direction, question_text FROM attempts WHERE item_id = 1 ORDER BY completed_at DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(exact.verdict, "correct");
		assert.equal(exact.kind, "recall");
		assert.equal(exact.direction, "forward");
		assert.equal(exact.question_text, "语法填空：The fix that ___ (commit) this morning won't take effect until you reload.");

		// A near-miss form goes to the strict LLM rubric → partial → Again with the correction.
		makeClozeDue();
		await fake.fire();
		await harness.commands["anki:answer"].handler("was commit", harness.ctx);
		const partial = harness.widget().join(" ");
		assert.match(partial, /差一点/);
		assert.match(partial, /正确：was committed/);
		check = openTestDb();
		const nearMiss = check.prepare("SELECT verdict FROM attempts WHERE item_id = 1 ORDER BY completed_at DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(nearMiss.verdict, "partial");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("sentence spelling feedback highlights the changed letter order", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-spelling-diff" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				verdict: "partial",
				feedback: "拼写错误：claers 应为 clears。",
				errorTags: ["spelling"],
				correctedAnswer: "The extension clears resources during shutdown.",
			})),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "spelling-diff" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension claers resources during shutdown.", harness.ctx);
		assert.match(harness.widget().join(" "), /拼写对比：cl\[ae\]rs → cl\[ea\]rs/);
		const reattached = await makeSession({ model, modelRegistry: registry, sessionId: "spelling-diff-reattached" });
		assert.match(reattached.widget().join(" "), /拼写对比：cl\[ae\]rs → cl\[ea\]rs/, "highlight survives SQLite reattachment");
		await reattached.handlers.session_shutdown({ reason: "quit" }, reattached.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("a natural L3 variant accepted by the SDK evaluator completes as Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-sentence-variant-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				verdict: "correct",
				feedback: "表达自然",
				errorTags: [],
				correctedAnswer: "Since it owns the runtime, the extension cleans up during shutdown so callbacks are not registered twice.",
			})),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "sentence-variant" });
		const db = openTestDb();
		insertSentence(db);
		db.prepare("UPDATE items SET progress=2, shown=1 WHERE id=1").run();
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("Since it owns the runtime, the extension cleans up during shutdown so callbacks aren't registered twice.", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		const attempt = check.prepare("SELECT verdict,explicit_rating,kind FROM attempts WHERE item_id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { progress: 2, reviews: 1 });
		assert.deepEqual({ ...attempt }, { verdict: "correct", explicit_rating: "good", kind: "sentence_production" });
		assert.equal(registration.state.callCount, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("sentence hint survives reattachment and prevents a clean Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "sentence-hint-a" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await a.commands["anki:hint"].handler("", a.ctx);
		const before = openTestDb();
		const cycleId = String((before.prepare("SELECT active_review_cycle_id FROM runtime_state WHERE id=1").get() as any).active_review_cycle_id);
		before.close();
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);

		const b = await makeSession({ sessionId: "sentence-hint-b" });
		await b.commands["anki:answer"].handler("extension", b.ctx);
		await b.commands["anki:answer"].handler("The extension clears resources during shutdown.", b.ctx);
		await b.commands["anki:answer"].handler("Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.", b.ctx);
		const check = openTestDb();
		const rated = check.prepare("SELECT explicit_rating FROM attempts WHERE review_cycle_id=? AND explicit_rating IS NOT NULL").get(cycleId) as any;
		const mastery = check.prepare("SELECT unassisted_good,consecutive_again FROM mastery_state WHERE item_id=1").get() as any;
		check.close();
		assert.equal(rated.explicit_rating, "again");
		assert.deepEqual({ ...mastery }, { unassisted_good: 0, consecutive_again: 1 });
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("sentence evaluator unavailability keeps the card pending with zero attempt writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		const before = openTestDb();
		const version = Number((before.prepare("SELECT active_version FROM runtime_state WHERE id=1").get() as any).active_version);
		before.close();
		await harness.commands["anki:answer"].handler("wrong", harness.ctx);
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id,active_version FROM runtime_state WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any).n);
		const reviews = Number((check.prepare("SELECT reviews FROM items WHERE id=1").get() as any).reviews);
		check.close();
		assert.deepEqual({ ...state }, { active_item_id: 1, active_version: version });
		assert.equal(attempts, 0);
		assert.equal(reviews, 0);
		assert.ok(harness.notifications().some((message) => /没有记录成绩/.test(message)));
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
		await harness.commands["anki:skip"].handler("", harness.ctx);
		await fake.fire();
		assert.match(harness.widget().join(" "), /clear a timer/, "queued new card surfaces after deferred replacement generation");
		await harness.commands["anki:skip"].handler("", harness.ctx);
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

test("a due review is activated before any replacement LLM call", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-priority" });
	let llmCalls = 0;
	try {
		registration.setResponses([async () => {
			llmCalls++;
			return fauxAssistantMessage(JSON.stringify({ ready: false, reason: "unused" }));
		}]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-priority" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','known','熟词',?,?,1)")
			.run(now, new Date(Date.now() + 86_400_000).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','due','到期',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		check.close();
		assert.equal(state.active_item_id, 2);
		assert.equal(llmCalls, 0, "due review must not wait for replacement generation");
		assert.deepEqual(queue, ["word"], "replacement obligation stays queued");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("skipping a legacy sentence card replaces it with a cloze card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-skip-map" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: {
					type: "cloze",
					text: "The hotfix that ___ (push) to production yesterday broke the build pipeline again.",
					meaning: "was pushed",
					example: "The hotfix that was pushed to production yesterday broke the build pipeline again.",
					example_cn: "昨天推到生产的那个热修又把构建流水线搞坏了。（考点：被动语态）",
					chunks: ["The hotfix", "that was pushed to production yesterday", "broke the build pipeline again"],
				},
			})),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "skip-map" });
		const db = openTestDb();
		insertSentence(db);
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /句子输出（L1\/3）/, "legacy sentence card still surfaces normally");
		await harness.commands["anki:skip"].handler("", harness.ctx);
		await fake.flush();
		assert.match(harness.widget().join(" "), /语法填空/, "replacement cloze card is shown");
		const check = openTestDb();
		const items = check.prepare("SELECT type, text, status, introduction_kind FROM items ORDER BY id").all() as any[];
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'" ).get() as any).value));
		const genLog = String((check.prepare("SELECT value FROM stats WHERE key='gen_log'").get() as any)?.value ?? "");
		check.close();
		assert.equal(items.length, 2, "skipped sentence plus one replacement");
		assert.equal(items[0].status, "mastered");
		assert.equal(items[1].type, "cloze", "legacy sentence replacement generates a cloze card");
		assert.match(items[1].text, /^The hotfix that ___ \(push\)/);
		assert.equal(items[1].introduction_kind, "replacement");
		assert.deepEqual(queue, [], "FIFO obligation consumed");
		assert.match(genLog, /replacement_mapped: sentence→cloze/, "mapping is recorded in the gen log");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("successful replacement is one-for-one, critic-approved, and quota-free", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-ready" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "/ˈdedlaɪn/", meaning: "截止时间", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-ready" });
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const items = check.prepare("SELECT text,shown,status,introduction_kind,introduced_at FROM items ORDER BY id").all() as any[];
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const plannedToday = Number((check.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='planned' AND introduced_at IS NOT NULL").get() as any).n);
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(items.length, 2, "one skipped card creates exactly one replacement");
		assert.deepEqual(
			{ text: items[1].text, shown: items[1].shown, kind: items[1].introduction_kind, introduced: Boolean(items[1].introduced_at) },
			{ text: "deadline", shown: 1, kind: "replacement", introduced: true },
		);
		assert.equal(plannedToday, 1, "replacement does not consume planned quota");
		assert.deepEqual(queue, [], "FIFO obligation is consumed only after insertion");
		assert.equal(active.active_item_id, 2);
		assert.equal(registration.state.callCount, 2, "replacement generator and independent critic both ran");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("replacement critic rejection preserves the FIFO obligation and inserts nothing", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-reject" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "reject" }], summary: "rejected" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-reject" });
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(registration.state.callCount, 2);
		assert.equal(count, 1);
		assert.deepEqual(queue, ["word"]);
		assert.equal(active.active_item_id, null);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("conversation changes during replacement critique make the result stale", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-conversation-stale" });
	let releaseCritic!: () => void;
	let criticStarted!: () => void;
	const gate = new Promise<void>((resolve) => { releaseCritic = resolve; });
	const started = new Promise<void>((resolve) => { criticStarted = resolve; });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			async () => { criticStarted(); await gate; return fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })); },
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-conversation-stale" });
		let conversation = "old topic";
		harness.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: conversation }] } }];
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		const inFlight = harness.commands["anki:skip"].handler("", harness.ctx);
		await started;
		conversation = "new topic";
		releaseCritic();
		await inFlight;
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		check.close();
		assert.equal(count, 1, "stale critic result inserts no replacement");
		assert.deepEqual(queue, ["word"], "stale result cannot consume the FIFO obligation");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseCritic?.();
		registration.unregister();
		fake.restore();
	}
});

test("a review becoming due during replacement critique prevents replacement activation", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-late-due" });
	let releaseCritic!: () => void;
	let criticStarted!: () => void;
	const gate = new Promise<void>((resolve) => { releaseCritic = resolve; });
	const started = new Promise<void>((resolve) => { criticStarted = resolve; });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			async () => { criticStarted(); await gate; return fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })); },
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-late-due" });
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		const inFlight = harness.commands["anki:skip"].handler("", harness.ctx);
		await started;
		const during = openTestDb();
		during.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','overdue','已到期',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		during.close();
		releaseCritic();
		await inFlight;
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(count, 2, "replacement is not inserted ahead of a newly due review");
		assert.deepEqual(queue, ["word"]);
		assert.equal(active.active_item_id, null);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseCritic?.();
		registration.unregister();
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
		await harness.commands["anki:skip"].handler("", harness.ctx);
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


// -- Multi-session consistency ------------------------------------------

function insertDueWord(db: DatabaseSync, text: string, meaning: string) {
	db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word',?,?,?,?)")
		.run(text, meaning, new Date().toISOString(), new Date(0).toISOString());
}

function lessonResponse(topic = "concurrency") {
	return JSON.stringify({
		ready: true,
		topic,
		items: [
			{ type: "word", text: "coordinate", phonetic: "/koʊˈɔːrdɪneɪt/", meaning: "协调", example: "We coordinate shared work.", example_cn: "我们协调共享工作。" },
			{ type: "phrase", text: "single source of truth", phonetic: "", meaning: "唯一事实来源", example: "SQLite is the single source of truth.", example_cn: "SQLite 是唯一事实来源。" },
			{
				type: "cloze", text: "The fix that ___ (commit) this morning won't take effect until you reload.", phonetic: "", meaning: "was committed",
				example: "The fix that was committed this morning won't take effect until you reload.", example_cn: "今早提交的修复要等你重载后才生效。（考点：一般过去时被动语态）",
				chunks: ["The fix", "that was committed this morning", "won't take effect", "until you reload"],
			},
		],
	});
}

/** A lesson whose 20-word cloze sentence is out of the cold-start B1 budget [12,18] (too long). */
function longLessonResponse(topic = "out-of-budget") {
	return JSON.stringify({
		ready: true,
		topic,
		items: [
			{ type: "word", text: "persist", phonetic: "/pərˈsɪst/", meaning: "持久化", example: "We persist the data.", example_cn: "我们持久化数据。" },
			{ type: "phrase", text: "difficulty budget", phonetic: "", meaning: "难度预算", example: "The budget guides the lesson.", example_cn: "预算指导备课。" },
			{
				type: "cloze", text: "Because the system ___ (store) every learner attempt with its direction the profile recomputes a fresh difficulty budget each time now.", phonetic: "", meaning: "stores",
				example: "Because the system stores every learner attempt with its direction the profile recomputes a fresh difficulty budget each time now.", example_cn: "因为系统把每个学习者答题连同方向一起保存，画像每次都能重算出新的难度预算。",
				chunks: ["Because the system stores every learner attempt", "with its direction", "the profile recomputes a fresh difficulty budget", "each time now"],
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
		await a.commands["anki:good"].handler("", a.ctx);
		await b.commands["anki:good"].handler("", b.ctx);

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

		// A rates Good, clearing the global slot. (Manual self-report schedules Hard per P0-2.)
		await a.commands["anki:good"].handler("", a.ctx);
		assert.match(a.widget().join(" "), /记了个大概/);

		// B's poll notices the data_version change and drops the pending card.
		await fake.firePoll();
		assert.doesNotMatch(b.widget().join(" "), /timer/);
		// Anki-style rating schedules an immediate next-card work timer, so assert
		// the cross-session poll timers are intact instead of long work-timer delays.
		assert.equal(fake.poll().length, 2);

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
		await b.commands["anki:good"].handler("", b.ctx);
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
		await a.commands["anki:answer"].handler("extension", a.ctx);
		await b.commands["anki:answer"].handler("extension", b.ctx);
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
		await c.commands["anki:skip"].handler("", c.ctx);
		await d.commands["anki:skip"].handler("", d.ctx);
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
		registration.setResponses([
			fauxAssistantMessage(lessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
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
		assert.equal(registration.state.callCount, 2);
		assert.equal(count, 3);
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



test("schema migration is idempotent and registers adaptive protocol 1", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const checkSchema = () => {
			const db = openTestDb();
			const meta = db.prepare("SELECT schema_version, adaptive_protocol, migration_state FROM schema_meta WHERE id=1").get() as any;
			const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as any[]).map((r) => r.version);
			const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
			const itemCols = (db.prepare("PRAGMA table_info(items)").all() as any[]).map((r) => r.name);
			const runtimeCols = (db.prepare("PRAGMA table_info(runtime_state)").all() as any[]).map((r) => r.name);
			const attemptCols = (db.prepare("PRAGMA table_info(attempts)").all() as any[]).map((r) => r.name);
			const idxNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((r) => r.name);
			db.close();
			assert.deepEqual({ ...meta }, { schema_version: 11, adaptive_protocol: 1, migration_state: "complete" });
			assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
			for (const t of ["lessons","lexical_senses","lexical_surface_versions","exercises","exercise_senses","supporting_materials","content_catalog_state","attempts","mastery_state","content_reports","fsrs_corruptions","tutor_jobs","tutor_job_artifacts","replacement_requests","runtime_clients","schema_meta","schema_migrations"]) {
				assert.ok(tableNames.includes(t), `table ${t} exists`);
			}
			for (const c of ["lesson_id","lexical_sense_id","role","content_fingerprint","content_version","introduced_at","introduction_kind","introduction_accuracy","content_status","legacy_duplicate_of","fsrs_status","fsrs_error","fsrs_corrupt_at"]) {
				assert.ok(itemCols.includes(c), `items.${c} exists`);
			}
			for (const c of ["active_direction", "active_review_cycle_id", "active_exercise_id", "active_cycle_outcome", "active_retry_count", "active_assistance_level"]) {
				assert.ok(runtimeCols.includes(c), `runtime_state.${c} exists`);
			}
			assert.ok(attemptCols.includes("direction"), "attempts.direction exists");
			assert.ok(attemptCols.includes("question_text"), "attempts.question_text exists");
			assert.ok(idxNames.includes("items_content_fingerprint_uq"), "fingerprint unique index exists");
		};
		checkSchema();
		// A second session reopens the same DB: the migration must not re-run.
		await makeSession({ sessionId: "migration-idempotent" });
		checkSchema();
		const db = openTestDb();
		const client = db.prepare("SELECT protocol_version, last_seen FROM runtime_clients WHERE client_id LIKE 'migration-idempotent%'").get() as any;
		db.close();
		assert.ok(client, "second session registered a client heartbeat");
		assert.equal(client.protocol_version, 1);
		assert.ok(client.last_seen);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("v5 upgrades an existing v4 database without losing cards", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v4-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		insertDueWord(db, "preserved", "保留");
		for (const column of ["active_assistance_level", "active_retry_count", "active_cycle_outcome", "active_exercise_id", "active_review_cycle_id"]) {
			db.exec(`ALTER TABLE runtime_state DROP COLUMN ${column}`);
		}
		db.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
		db.prepare("UPDATE schema_meta SET schema_version = 4 WHERE id = 1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v5-target" });
		db = openTestDb();
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		const cols = (db.prepare("PRAGMA table_info(runtime_state)").all() as any[]).map((row) => row.name);
		const card = db.prepare("SELECT text,meaning FROM items WHERE text='preserved'").get() as any;
		db.close();
		assert.equal(meta.schema_version, 11);
		for (const column of ["active_review_cycle_id", "active_exercise_id", "active_cycle_outcome", "active_retry_count", "active_assistance_level"]) {
			assert.ok(cols.includes(column), `${column} migrated`);
		}
		assert.deepEqual({ ...card }, { text: "preserved", meaning: "保留" });
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v7 restores fractional elapsed_days false-positive quarantines without losing history", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v7-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		const state = JSON.stringify({
			due: "2026-08-12T00:52:51.430Z",
			stability: 1.1801865605280295,
			difficulty: 6.632799999999999,
			elapsed_days: 2.4368512962962963,
			scheduled_days: 0,
			reps: 5,
			lapses: 1,
			state: 3,
			last_review: "2026-08-12T00:47:51.430Z",
		});
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,reviews,fsrs_state,fsrs_status,fsrs_error,fsrs_corrupt_at) VALUES('sentence','preserved state','保留状态',?,?,1,5,?,'corrupt','invalid_field:elapsed_days',?)")
			.run(new Date().toISOString(), "2026-08-12T03:02:04.451Z", state, new Date().toISOString());
		db.prepare("INSERT INTO fsrs_corruptions(item_id,raw_fsrs_state,error_code,detected_at,resolution) VALUES(1,?,'invalid_field:elapsed_days',?,NULL)")
			.run(state, new Date().toISOString());
		db.prepare("DELETE FROM schema_migrations WHERE version=7").run();
		db.prepare("UPDATE schema_meta SET schema_version=6 WHERE id=1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v7-target" });
		db = openTestDb();
		const item = db.prepare("SELECT reviews,fsrs_state,fsrs_status,fsrs_error,fsrs_corrupt_at FROM items WHERE id=1").get() as any;
		const corruption = db.prepare("SELECT resolution FROM fsrs_corruptions WHERE item_id=1").get() as any;
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		db.close();
		assert.equal(meta.schema_version, 11);
		assert.deepEqual({ ...item }, { reviews: 5, fsrs_state: state, fsrs_status: "ok", fsrs_error: null, fsrs_corrupt_at: null });
		assert.equal(corruption.resolution, "restored:v7_fractional_elapsed_days_false_positive");
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v8 upgrades an existing v7 database and preserves directionless attempts", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v8-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		insertDueWord(db, "preserved", "保留");
		db.exec("ALTER TABLE attempts DROP COLUMN direction");
		db.prepare(
			"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, assistance_level, status, verdict, explicit_rating, started_at, completed_at, rated_at) VALUES ('legacy-attempt', 1, NULL, 'legacy-cycle', 'legacy-claim', 1, 1, 'recall', 'none', 'evaluated', 'correct', 'good', ?, ?, ?)",
		).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
		db.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
		db.prepare("UPDATE schema_meta SET schema_version = 7 WHERE id = 1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v8-target" });
		db = openTestDb();
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		const cols = (db.prepare("PRAGMA table_info(attempts)").all() as any[]).map((row) => row.name);
		const attempt = db.prepare("SELECT verdict, direction FROM attempts WHERE id = 'legacy-attempt'").get() as any;
		db.close();
		assert.equal(meta.schema_version, 11);
		assert.ok(cols.includes("direction"), "direction migrated");
		assert.deepEqual({ ...attempt }, { verdict: "correct", direction: null });
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v11 upgrades an existing v10 database and admits cloze items", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v11-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		insertDueWord(db, "preserved", "保留");
		// Rebuild items with the pre-cloze CHECK to simulate a v10 database.
		const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get() as any).sql as string;
		db.exec(createSql
			.replace(/CREATE TABLE "?items"?\s*\(/, "CREATE TABLE items_v10 (")
			.replace("'word', 'phrase', 'sentence', 'cloze'", "'word', 'phrase', 'sentence'"));
		db.exec("INSERT INTO items_v10 SELECT * FROM items; DROP TABLE items; ALTER TABLE items_v10 RENAME TO items;");
		assert.throws(
			() => db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('cloze','x ___ y','答案',?,?)").run(new Date().toISOString(), new Date(0).toISOString()),
			/CHECK constraint failed/,
			"v10 schema rejects cloze items",
		);
		db.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
		db.prepare("UPDATE schema_meta SET schema_version = 10 WHERE id = 1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v11-target" });
		db = openTestDb();
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		const card = db.prepare("SELECT text,meaning FROM items WHERE text='preserved'").get() as any;
		db.prepare(
			"INSERT INTO items(type,text,phonetic,meaning,example,example_cn,learned_at,due_at) VALUES('cloze',?,NULL,?,?,?, ?,?)",
		).run(
			"The fix that ___ (commit) this morning won't take effect until you reload.",
			"was committed",
			"The fix that was committed this morning won't take effect until you reload.",
			"今早提交的修复要等你重载后才生效。",
			new Date().toISOString(),
			new Date(0).toISOString(),
		);
		db.close();
		assert.equal(meta.schema_version, 11, "v11 migration applied");
		assert.deepEqual({ ...card }, { text: "preserved", meaning: "保留" }, "existing cards survive the rebuild");
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("legacy teach-state cloze renders as a quiz and answers", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-cloze-legacy-teach" });
	try {
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		// Persist an active cloze card claimed under the old code (active_kind='teach').
		const seed = await makeSession({ model, modelRegistry: registry, sessionId: "cloze-legacy-seed" });
		await seed.handlers.session_shutdown({ reason: "quit" }, seed.ctx);
		const db = openTestDb();
		insertClozeCard(db, 1);
		db.prepare("UPDATE runtime_state SET active_item_id = 1, active_kind = 'teach', active_direction = 'forward', active_version = active_version + 1 WHERE id = 1").run();
		db.close();
		// Reattach: the persisted teach state must not restore the leaking teach face.
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "cloze-legacy-reattach" });
		const face = harness.widget().join(" ");
		assert.match(face, /语法填空：The fix that ___ \(commit\)/);
		assert.doesNotMatch(face, /was committed|句意|考点/, "legacy teach state renders the quiz face");
		// Flip reveals the answer side (was a no-op on the old teach face),
		// including the meaning-chunk reading aid.
		await harness.commands["anki:flip"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /was committed/, "flip reveals the answer");
		assert.match(harness.widget().join(" "), /意群：The fix \/ that was committed this morning/, "answer face shows chunks");
		// And the card is answerable without flip, graded like a review.
		await harness.commands["anki:answer"].handler("was committed", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("introduced_at is stamped when a new card is first displayed", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "quota-stamp" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','first','意',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=NULL, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		const check = openTestDb();
		const row = check.prepare("SELECT shown,introduced_at,introduction_kind FROM items WHERE id=1").get() as any;
		check.close();
		assert.equal(row.shown, 1);
		assert.equal(row.introduction_kind, "planned");
		assert.ok(row.introduced_at, "introduced_at stamped at first display");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("planned new-card quota blocks extra new cards at display", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ sessionId: "quota-block" });
		const db = openTestDb();
		// Card 1: already introduced today and scheduled into the future (quota used).
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','first','意',?,?,1,?,'planned')")
			.run(new Date().toISOString(), "2099-01-01T00:00:00.000Z", new Date().toISOString());
		// Card 2: a queued-new card due now.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','second','意二',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=NULL, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		const check = openTestDb();
		const item2 = check.prepare("SELECT shown,introduced_at,introduction_kind FROM items WHERE id=2").get() as any;
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(item2.shown, 0, "queued-new card not claimed over quota");
		assert.equal(item2.introduced_at, null, "queued-new card not stamped over quota");
		assert.equal(state.active_item_id, null, "no active card surfaced over quota");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a negative dailyNewLimit falls back to the default quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: -1, maxTokens: -1 });
		const harness = await makeSession({ sessionId: "invalid-config-defaults" });
		const db = openTestDb();
		for (const [text, meaning] of [["one", "一"], ["two", "二"], ["three", "三"], ["four", "四"]]) {
			insertDueWord(db, text, meaning);
		}
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 1 · 新卡 2）/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("today remaining counts due cards plus only the available new-card quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 2 });
		const harness = await makeSession({ sessionId: "remaining-quota" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','review','复习',?,?,1,?,'planned')")
			.run(now, new Date(0).toISOString(), now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','new-one','新一',?,?)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','new-two','新二',?,?)").run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=NULL, next_check_at=? WHERE id=1").run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 1 · 新卡 1）/, "current review plus one quota-eligible new card");
		await harness.commands["anki:good"].handler("", harness.ctx);
		const after = openTestDb();
		const localStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
		const planned = Number((after.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='planned' AND introduced_at >= ?").get(localStart) as any).n);
		const queued = Number((after.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=0").get() as any).n);
		const tomorrow = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).toISOString();
		const due = Number((after.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1 AND due_at < ?").get(tomorrow) as any).n);
		after.close();
		assert.deepEqual({ planned, queued }, { planned: 1, queued: 2 });
		assert.match(
			harness.widget().join(" "),
			new RegExp(`今日剩余卡片（复习 ${due} · 新卡 1）`),
			"status separates cards still due later today from one quota-eligible new card",
		);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("today remaining includes hidden quota-free replacements after planned quota is full", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ sessionId: "remaining-hidden-replacement" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','used','已用',?,?,1,?,'planned')")
			.run(now, "2099-01-01T00:00:00.000Z", now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind) VALUES('word','replacement','补卡',?,?,0,'replacement')")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind) VALUES('word','planned','计划卡',?,?,0,'planned')")
			.run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET next_check_at=? WHERE id=1").run("2099-01-01T00:00:00.000Z");
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 0 · 新卡 1）/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("dailyNewLimit zero allows every queued planned card to surface", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "quota-unlimited" });
		const db = openTestDb();
		for (const [text, meaning] of [["one", "一"], ["two", "二"], ["three", "三"]]) insertDueWord(db, text, meaning);
		db.close();
		for (const text of ["one", "two", "three"]) {
			await fake.fire(fake.active().find((timer) => timer.delay === 0) ?? fake.active()[0]);
			assert.match(harness.widget().join(" "), new RegExp(text));
			if (text !== "three") await harness.commands["anki:good"].handler("", harness.ctx);
		}
		const check = openTestDb();
		const shown = Number((check.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1 AND introduction_kind='planned' AND introduced_at IS NOT NULL").get() as any).n);
		check.close();
		assert.equal(shown, 3);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a matured Skip card due today is counted and claimable", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ sessionId: "matured-skip-due" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,status) VALUES('word','matured','到期熟词',?,?,1,'mastered')")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /到期熟词/);
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 1）/);
		assert.doesNotMatch(harness.widget().join(" "), /新卡 0/);
		const check = openTestDb();
		const active = check.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...active }, { active_item_id: 1, active_kind: "review" });
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("content fingerprint unique index rejects exact duplicates", { concurrency: false }, async () => {
	const harness = await createHarness();
	try {
		const db = openTestDb();
		const now = new Date().toISOString();
		const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='items_content_fingerprint_uq'").get() as any;
		assert.ok(idx, "fingerprint unique index exists");
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,content_fingerprint) VALUES('word','x','意',?,?,?)").run(now, now, "FP1");
		assert.throws(() =>
			db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,content_fingerprint) VALUES('word','x2','意',?,?,?)").run(now, now, "FP1"),
			/duplicate|constraint/i,
		);
		// Distinct fingerprint succeeds.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,content_fingerprint) VALUES('word','y','意二',?,?,?)").run(now, now, "FP2");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		// no fake timers used
	}
});

test("generated lesson items carry unique content fingerprints", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-fp-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("fingerprint")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "fp-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const fps = (db.prepare("SELECT content_fingerprint FROM items WHERE content_fingerprint IS NOT NULL").all() as any[]).map((r) => r.content_fingerprint);
		db.close();
		assert.ok(fps.length > 0, "lesson items stamped with fingerprint");
		assert.equal(new Set(fps).size, fps.length, "fingerprints are unique");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("word/phrase items link to a lexical sense; cloze items do not", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-sense-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("senses")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "sense-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const linked = db.prepare("SELECT COUNT(*) AS n FROM items WHERE type IN ('word','phrase') AND lexical_sense_id IS NOT NULL").get() as any;
		const cloze = db.prepare("SELECT lexical_sense_id FROM items WHERE type='cloze'").get() as any;
		const senses = db.prepare("SELECT COUNT(*) AS n FROM lexical_senses").get() as any;
		const distinctFps = (db.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT sense_fingerprint FROM lexical_senses)").get() as any).n;
		db.close();
		assert.ok(Number(linked.n) >= 2, "word/phrase items linked to senses");
		assert.equal(cloze.lexical_sense_id, null, "cloze has no sense");
		assert.ok(Number(senses.n) >= 2, "distinct senses created");
		assert.equal(Number(senses.n), distinctFps, "sense fingerprints are unique");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("quality gate rejects lessons the critic flags and commits nothing", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-gate-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("gated")),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "句子不自然" }], summary: "不自然" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "gate-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id, generation_token FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(count, 0, "no items committed when the critic rejects");
		assert.equal(state.active_item_id, null, "no active card after rejection");
		assert.equal(state.generation_token, null, "generation lease released after rejection");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("deterministic budget gate rejects an out-of-budget generated lesson with zero writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-budget-gate" });
	try {
		// Cold-start DB -> B1 budget [12,18]. Each generated lesson has a 20-word
		// cloze sentence (too long): the deterministic critic gate rejects it
		// before any LLM critic call.
		registration.setResponses([
			fauxAssistantMessage(longLessonResponse("too-long-1")),
			fauxAssistantMessage(longLessonResponse("too-long-2")),
			fauxAssistantMessage(longLessonResponse("too-long-3")),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "budget-gate" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id, generation_token FROM runtime_state WHERE id=1").get() as any;
		const status = String((db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value);
		db.close();
		assert.equal(count, 0, "out-of-budget lesson writes nothing");
		assert.equal(state.active_item_id, null, "no active card after deterministic rejection");
		assert.equal(state.generation_token, null, "generation lease released");
		assert.match(status, /critic_rejected/, "deterministic gate reject recorded as critic_rejected");
		// Only the 3 generation calls ran; the LLM critic was never consulted because
		// the deterministic gate short-circuited every critiqueLesson.
		assert.equal(registration.state.callCount, 3, "no LLM critic call for the deterministic gate");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("critic bad JSON fails closed and commits no lesson", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-critic-bad-json" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("bad-critic-json")),
			fauxAssistantMessage("not-json"),
			fauxAssistantMessage(JSON.stringify({ ready: false, reason: "defer revision" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "critic-bad-json" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const status = String((db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value);
		db.close();
		assert.equal(count, 0);
		assert.match(status, /critic_unavailable/);
		assert.equal(registration.state.callCount, 2, "unavailable critic defers without wasting a revision call");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("revision loop recovers a lesson after an initial critic rejection", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-rev-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("rev-v1")),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "不自然" }], summary: "需修订" })),
			fauxAssistantMessage(lessonResponse("rev-fixed")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "rev-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(registration.state.callCount, 4, "generate + critique + revise generate + revise critique");
		assert.ok(count > 0, "revised lesson committed after the critic approved it");
		assert.equal(state.active_item_id, 1, "revised lesson activated");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("fallback session model is reused for the critic after configured generator failure", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const primary = registerFauxProvider({ provider: "kaomoji-primary-failure" });
	const fallback = registerFauxProvider({ provider: "kaomoji-session-fallback" });
	try {
		fallback.setResponses([
			fauxAssistantMessage(lessonResponse("fallback")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved by fallback" })),
		]);
		const primaryModel = primary.getModel();
		const fallbackModel = fallback.getModel();
		const models = [primaryModel, fallbackModel];
		let primaryAuthCalls = 0;
		const registry = {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async (model: any) => {
				if (model.provider === primaryModel.provider) {
					primaryAuthCalls++;
					throw new Error("primary unavailable");
				}
				return { ok: true, apiKey: "test-key" };
			},
		};
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3, provider: primaryModel.provider, model: primaryModel.id });
		await makeSession({ model: fallbackModel, modelRegistry: registry, sessionId: "model-fallback" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		db.close();
		assert.ok(primaryAuthCalls >= 1, "configured provider was attempted first");
		assert.equal(fallback.state.callCount, 2, "fallback handles generation and independent critique");
		assert.equal(count, 3);
	} finally {
		primary.unregister();
		fallback.unregister();
		fake.restore();
	}
});

test("active recall: a correct answer is judged and recorded", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','hello','你好',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /你好/, "review front shows the Chinese meaning, not the English answer");
		await harness.commands["anki:answer"].handler("hello", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		assert.equal(fake.active().length, 1, "normal pacing timer remains when the queue is empty");
		assert.ok(fake.active()[0].delay > 590_000, "feedback is not overwritten by a 0ms idle tick");
		const check = openTestDb();
		const att = check.prepare("SELECT verdict, kind, answer_text, direction FROM attempts WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(att.verdict, "correct");
		assert.equal(att.kind, "recall");
		assert.equal(att.answer_text, "hello");
		assert.equal(att.direction, "forward");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("active recall without model: a wrong answer stays pending with zero writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','world','世界',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("word", harness.ctx);
		assert.ok(harness.notifications().some((m) => /无法可靠判断/.test(m)), "warning shown for unavailable evaluator");
		const check = openTestDb();
		const att = check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id = 1").get() as any;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const item = check.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const mastery = Number((check.prepare("SELECT COUNT(*) AS n FROM mastery_state WHERE item_id=1").get() as any).n);
		check.close();
		assert.equal(att.n, 0, "zero attempts when evaluator unavailable");
		assert.equal(active.active_item_id, 1, "card stays pending");
		assert.deepEqual({ ...item }, { reviews: 0, fsrs_state: "" });
		assert.equal(mastery, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("bad evaluator JSON leaves word card pending with zero authoritative writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-eval-bad-json" });
	try {
		registration.setResponses([fauxAssistantMessage("not-json")]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "eval-bad-json" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','world','世界',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("word", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any).n);
		const mastery = Number((check.prepare("SELECT COUNT(*) AS n FROM mastery_state").get() as any).n);
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { reviews: 0, fsrs_state: "" });
		assert.equal(attempts, 0);
		assert.equal(mastery, 0);
		assert.equal(active.active_item_id, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("LLM evaluation marks a near-miss answer as partial with feedback", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-eval-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ verdict: "partial", feedback: "少了复数 s" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "eval-a" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','apples','苹果',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("apple", harness.ctx);
		assert.match(harness.widget().join(" "), /差一点/);
		const check = openTestDb();
		const att = check.prepare("SELECT verdict, feedback_json, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		const item = check.prepare("SELECT reviews FROM items WHERE id=1").get() as any;
		const mastery = check.prepare("SELECT consecutive_again FROM mastery_state WHERE item_id=1").get() as any;
		check.close();
		assert.equal(att.verdict, "partial");
		assert.equal(att.explicit_rating, "again");
		assert.match(att.feedback_json, /少了复数/);
		assert.equal(item.reviews, 1);
		assert.equal(mastery.consecutive_again, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("recall exercise template is persisted when a card is answered", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','cat','猫',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("cat", harness.ctx);
		const check = openTestDb();
		const ex = check.prepare("SELECT kind, stage, content_fingerprint FROM exercises WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(ex.kind, "recall");
		assert.equal(ex.stage, "recall");
		assert.ok(ex.content_fingerprint, "exercise fingerprint stamped");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("mastery state tracks Good and Again evidence", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','dog','狗',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		let check = openTestDb();
		let m = check.prepare("SELECT unassisted_good, consecutive_again, stage FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...m }, { unassisted_good: 0, consecutive_again: 1, stage: "exposure" });
		// Re-due the card, then rate Good.
		const db2 = openTestDb();
		db2.prepare("UPDATE items SET due_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.prepare("UPDATE runtime_state SET active_item_id = NULL, next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("dog", harness.ctx);
		check = openTestDb();
		m = check.prepare("SELECT stage, unassisted_good, consecutive_again FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(m.unassisted_good, 1, "objective correct clears the streak and counts one unassisted success");
		assert.equal(m.consecutive_again, 0, "Good resets consecutive Again");
		assert.equal(m.stage, "recognition", "one Good promotes exposure -> recognition");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("consecutive Again triggers a reinforcement hint", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,example,example_cn,learned_at,due_at,shown) VALUES('word','run','跑','He runs fast.','他跑得快。',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state (item_id, stage, unassisted_good, consecutive_again, updated_at) VALUES (1, 'recognition', 0, 1, ?)").run(now);
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /反复忘了/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("anki:stats reports mastery distribution and accuracy without error", { concurrency: false }, async () => {
	const harness = await createHarness();
	try {
		assert.equal(typeof harness.commands["anki:stats"], "object");
		// Exercises the full query path on an empty DB (no rows → "暂无", 0 attempts).
		await harness.commands["anki:stats"].handler("", harness.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		// no fake timers
	}
});

test("schema_meta records completed migration version", { concurrency: false }, async () => {
	const harness = await createHarness();
	const db = openTestDb();
	const meta = db.prepare("SELECT schema_version, migration_state FROM schema_meta WHERE id=1").get() as any;
	db.close();
	assert.equal(meta.schema_version, 11, "schema migrated to v11");
	assert.equal(meta.migration_state, "complete");
	await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
});

test("mastery stage promotes to controlled_recall after a second Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','deploy','部署',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,consecutive_again,updated_at) VALUES(1,'recognition',1,0,?)").run(now);
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("deploy", harness.ctx);
		const ck = openTestDb();
		const m = ck.prepare("SELECT stage, unassisted_good FROM mastery_state WHERE item_id=1").get() as any;
		ck.close();
		assert.equal(m.stage, "controlled_recall", "second objective correct promotes recognition -> controlled_recall");
		assert.equal(m.unassisted_good, 2);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("mastery stage demotes one level on Again", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','deploy','部署',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,consecutive_again,updated_at) VALUES(1,'controlled_recall',2,0,?)").run(now);
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		const ck = openTestDb();
		const m = ck.prepare("SELECT stage, consecutive_again FROM mastery_state WHERE item_id=1").get() as any;
		ck.close();
		assert.equal(m.stage, "recognition", "Again demotes controlled_recall -> recognition");
		assert.equal(m.consecutive_again, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("persistent status stays compact while anki:stats keeps detailed metrics", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,consecutive_again,updated_at) VALUES(1,'exposure',0,2,?)").run(new Date().toISOString());
		db.close();
		await fake.fire();
		const status = harness.widget().join(" ");
		assert.doesNotMatch(status, /连续学习|今日剩余卡片/);
		assert.doesNotMatch(status, /需强化|今日新增|今日复习|已学/);
		await harness.commands["anki:stats"].handler("", harness.ctx);
		assert.ok(harness.notifications().some((message) => /需强化：1/.test(message)));
		// The profile/budget transparency line includes band, confidence, evidence counts, and the budget range.
		assert.ok(harness.notifications().some((message) => /画像：句法 B1\(证据0,低\)/.test(message)), "stats shows syntax band with evidence");
		assert.ok(harness.notifications().some((message) => /预算 12-18词\/巩固/.test(message)), "stats shows the conservative cold-start budget");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("lesson generation stamps content_fingerprint and lexical_sense_id", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-fp" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "fp" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const items = db.prepare("SELECT type, content_fingerprint, lexical_sense_id, introduction_kind, introduced_at FROM items ORDER BY id").all() as any[];
		const senses = (db.prepare("SELECT COUNT(*) AS n FROM lexical_senses").get() as any).n;
		db.close();
		assert.ok(items.length >= 3, "lesson inserted its three items");
		for (const it of items) {
			assert.ok(it.content_fingerprint, `${it.type} has content_fingerprint`);
			assert.equal(it.introduction_kind, "planned", `${it.type} stamped introduction_kind=planned`);
		}
		// Only the first card (displayed) has introduced_at; queued cards do not.
		assert.ok(items[0].introduced_at, "first item has introduced_at");
		for (let i = 1; i < items.length; i++) {
			assert.equal(items[i].introduced_at, null, `queued item ${i} has no introduced_at`);
		}
		const word = items.find((i) => i.type === "word");
		const phrase = items.find((i) => i.type === "phrase");
		const cloze = items.find((i) => i.type === "cloze");
		assert.ok(word.lexical_sense_id, "word linked to a lexical sense");
		assert.ok(phrase.lexical_sense_id, "phrase linked to a lexical sense");
		assert.ok(!cloze.lexical_sense_id, "cloze has no lexical sense");
		assert.ok(senses >= 2, "word + phrase each created a sense");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("duplicate content fingerprint is rejected at commit", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-dup" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "dup" });
		// Pre-insert the exact word the lesson will generate, with a future due date
		// so claimDueItem does not surface it before generation runs.
		const db0 = openTestDb();
		const fp = contentFingerprint("word", "coordinate", "协调");
		db0.prepare(
			"INSERT INTO items(type,text,meaning,learned_at,due_at,shown,content_fingerprint,introduction_kind) VALUES('word','coordinate','协调',?,?,1,?,'legacy')",
		).run(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), fp);
		db0.close();
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		db.close();
		assert.equal(count, 1, "duplicate lesson rejected, only the pre-existing item remains");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("critic rejection prevents insertion", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-critic" });
	const criticFail = JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "fact", description: "incorrect meaning" }], summary: "factual error" });
	const notReady = JSON.stringify({ ready: false, reason: "cannot fix without more context" });
	registration.setResponses([
		fauxAssistantMessage(lessonResponse()),	// initial generation: ready
		fauxAssistantMessage(criticFail),			// critic: reject
		fauxAssistantMessage(notReady),				// revision generation: gives up -> break loop
	]);
	const { model, registry } = fauxModelRegistry(registration);
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "critic" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		db.close();
		assert.equal(count, 0, "critic rejection blocked the lesson from being inserted");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("claimDueItem surfaces a new card within the dailyNewLimit quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 2 });
		const s = await makeSession({ sessionId: "quota" });
		const today = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind,introduced_at) VALUES('word','alpha','阿尔法',?,?,0,'planned',?)")
			.run(today, new Date(0).toISOString(), today);
		db.close();
		await fake.fire();
		assert.match(s.widget().join(" "), /alpha/, "new card surfaced within quota");
		const ck = openTestDb();
		const active = ck.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const item = ck.prepare("SELECT shown FROM items WHERE id=1").get() as any;
		ck.close();
		assert.equal(active.active_item_id, 1);
		assert.equal(item.shown, 1, "surfaced card marked shown");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		fake.restore();
	}
});

test("claimDueItem blocks new cards once dailyNewLimit is reached", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const s = await makeSession({ sessionId: "quota-full" });
		const today = new Date().toISOString();
		const db = openTestDb();
		// One planned card already counts against the quota of 1.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind,introduced_at) VALUES('word','beta','贝塔',?,?,0,'planned',?)")
			.run(today, new Date(0).toISOString(), today);
		// A second queued new card should not be surfaced.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind,introduced_at) VALUES('word','gamma','伽马',?,?,0,'planned',?)")
			.run(today, new Date(0).toISOString(), today);
		db.close();
		await fake.fire();
		const ck = openTestDb();
		const active = ck.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const shown = ck.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1").get() as any;
		ck.close();
		assert.equal(active.active_item_id, null, "no new card surfaced once quota is full");
		assert.equal(shown.n, 0, "neither queued card was marked shown");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		fake.restore();
	}
});

test("active recall: reverse direction asks for the Chinese meaning", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','hello','你好',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		// Direction comes from per-direction scheduling state: reverse is due, forward is not.
		db.prepare("INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(1,'forward','',?,?),(1,'reverse','',?,?)")
			.run("2099-01-01T00:00:00.000Z", new Date().toISOString(), new Date(0).toISOString(), new Date().toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /写出单词「hello」的中文释义/, "reverse front shows English, asks for Chinese");
		await harness.commands["anki:hint"].handler("", harness.ctx);
		assert.match(harness.notifications().at(-1) ?? "", /提示：你_/, "reverse hint masks the Chinese answer");
		await harness.commands["anki:answer"].handler("你好", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/, "correct Chinese answer auto-rates Good");
		const check = openTestDb();
		const att = check.prepare("SELECT verdict, answer_text, assistance_level, direction FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT stage, unassisted_good, assisted_good FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...att }, { verdict: "correct", answer_text: "你好", assistance_level: "hint", direction: "reverse" });
		assert.deepEqual({ ...mastery }, { stage: "exposure", unassisted_good: 0, assisted_good: 1 });
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("active recall direction is shared across sessions and survives reattachment", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "direction-a" });
		const b = await makeSession({ sessionId: "direction-b" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','persist','持久化',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		// Reverse direction is due; forward is not.
		db.prepare("INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(1,'forward','',?,?),(1,'reverse','',?,?)")
			.run("2099-01-01T00:00:00.000Z", new Date().toISOString(), new Date(0).toISOString(), new Date().toISOString());
		db.close();
		await fake.fire();
		await fake.fire();
		assert.match(a.widget().join(" "), /写出单词「persist」的中文释义/);
		assert.match(b.widget().join(" "), /写出单词「persist」的中文释义/);
		const check = openTestDb();
		const state = check.prepare("SELECT active_direction FROM runtime_state WHERE id = 1").get() as any;
		check.close();
		assert.equal(state.active_direction, "reverse");
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
		const c = await makeSession({ sessionId: "direction-c" });
		assert.match(c.widget().join(" "), /写出单词「persist」的中文释义/, "new session restores persisted direction");
		await c.handlers.session_shutdown({ reason: "quit" }, c.ctx);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
	} finally {
		fake.restore();
	}
});

test("flip-assisted correct answer schedules Again (a revealed answer is not recall evidence)", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','cat','猫',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,updated_at) VALUES(1,'controlled_recall',2,?)")
			.run(new Date().toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:flip"].handler("", harness.ctx);
		await harness.commands["anki:answer"].handler("cat", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT reviews FROM items WHERE id = 1").get() as any;
		const attempt = check.prepare("SELECT assistance_level, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT stage, unassisted_good, assisted_good, consecutive_again FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(item.reviews, 1, "the review still happened");
		assert.deepEqual({ ...attempt }, { assistance_level: "revealed", explicit_rating: "again" }, "correct-after-reveal schedules Again (P0-2)");
		assert.deepEqual({ ...mastery }, { stage: "recognition", unassisted_good: 0, assisted_good: 0, consecutive_again: 1 }, "a revealed answer produces no recall evidence");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("stale async answer cannot record or rate the next global card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-stale-eval" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "可接受" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "stale-answer-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "stale-answer-b" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','alpha','阿尔法',?,?,1)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','beta','贝塔',?,?,1)").run(now, new Date(0).toISOString());
		db.close();
		await fake.fire(); // A claims alpha.
		await fake.fire(); // B renders alpha.
		const inFlight = a.commands["anki:answer"].handler("alph", a.ctx);
		await started;
		await b.commands["anki:good"].handler("", b.ctx); // B rates alpha.
		assert.ok(fake.active().some((timer) => timer.delay === 0), "next due card is scheduled immediately");
		await fake.fire(fake.active().find((timer) => timer.delay === 0)); // B advances the global slot to beta.
		releaseResponse();
		await inFlight;
		const check = openTestDb();
		const items = check.prepare("SELECT text, reviews FROM items ORDER BY id").all() as any[];
		const attemptCount = (check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status = 'evaluated'").get() as any).n;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id = 1").get() as any;
		check.close();
		assert.deepEqual(items.map((row) => ({ ...row })), [
			{ text: "alpha", reviews: 1 },
			{ text: "beta", reviews: 0 },
		]);
		assert.equal(active.active_item_id, 2, "beta remains the authoritative next card");
		assert.equal(attemptCount, 0, "stale LLM result writes no evaluated attempt (B's manual self-report is recorded separately)");
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("stale sentence evaluator result writes no retry or rating after another session ends the cycle", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-stale-sentence-eval" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "自然变体", correctedAnswer: "extension" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "stale-sentence-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "stale-sentence-b" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await fake.fire();
		const inFlight = a.commands["anki:answer"].handler("extensio", a.ctx);
		await started;
		await b.commands["anki:again"].handler("", b.ctx);
		releaseResponse();
		await inFlight;
		const check = openTestDb();
		const item = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		const attempts = check.prepare("SELECT kind,direction,explicit_rating FROM attempts").all() as any[];
		const state = check.prepare("SELECT active_item_id,active_review_cycle_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { progress: 0, reviews: 1 });
		assert.deepEqual(attempts.map((attempt) => ({ ...attempt })), [{ kind: "sentence_self_report", direction: "forward", explicit_rating: "again" }]);
		assert.deepEqual({ ...state }, { active_item_id: null, active_review_cycle_id: null });
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("a sentence hint invalidates an in-flight clean evaluation", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-hint-race-eval" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "可接受", correctedAnswer: "extension" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "hint-race-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "hint-race-b" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await fake.fire();
		const inFlight = a.commands["anki:answer"].handler("extensio", a.ctx);
		await started;
		await b.commands["anki:hint"].handler("", b.ctx);
		releaseResponse();
		await inFlight;
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id,active_cycle_outcome,active_assistance_level FROM runtime_state WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any).n);
		const item = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...state }, { active_item_id: 1, active_cycle_outcome: "again", active_assistance_level: "hint" });
		assert.deepEqual({ ...item }, { progress: 0, reviews: 0 });
		assert.equal(attempts, 0);
		await b.commands["anki:again"].handler("", b.ctx);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("wrong-answer teaching remains visible before the next due card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "again-feedback" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','alpha','阿尔法',?,?,1)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','beta','贝塔',?,?,1)").run(now, new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /没关系，待会儿再考你一次/, "Again feedback is rendered");
		assert.equal(fake.active().length, 1);
		assert.ok(fake.active()[0].delay >= 14_900 && fake.active()[0].delay <= 15_000, "feedback gets a readable grace period");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("Anki-style: correct rating immediately surfaces the next due card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "anki" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','alpha','阿尔法',?,?,1)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','beta','贝塔',?,?,1)").run(now, new Date(0).toISOString());
		db.close();
		await fake.fire(); // surface first due card
		assert.match(a.widget().join(" "), /阿尔法|贝塔/, "first card shown");
		await a.commands["anki:good"].handler("", a.ctx); // correct rating -> scheduleTimer(0)
		assert.equal(fake.active().length, 1);
		assert.equal(fake.active()[0].delay, 0, "command handler must not overwrite the immediate timer");
		await fake.fire(); // immediate next-card tick
		const w = a.widget().join(" ");
		assert.ok(/阿尔法|贝塔/.test(w), "next due card surfaced without waiting");
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
	} finally {
		fake.restore();
	}
});

test("lesson items leave introduced_at NULL until first display", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-intro-test" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("intro-test")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "intro-test" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const items = db.prepare("SELECT introduced_at FROM items ORDER BY id").all() as any[];
		db.close();
		assert.equal(items.length, 3, "three lesson items");
		assert.ok(items[0].introduced_at, "first item stamped at display");
		assert.equal(items[1].introduced_at, null, "second item not yet displayed");
		assert.equal(items[2].introduced_at, null, "third item not yet displayed");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("fractional elapsed_days produced by fsrs.js remains schedulable", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "fractional-elapsed-days" });
		const db = openTestDb();
		const lastReview = new Date(Date.now() - 2.5 * 24 * 60 * 60 * 1000).toISOString();
		const state = JSON.stringify({
			due: new Date(0).toISOString(),
			stability: 1.18,
			difficulty: 6.63,
			elapsed_days: 2.5,
			scheduled_days: 1,
			reps: 5,
			lapses: 1,
			state: 3,
			last_review: lastReview,
		});
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,reviews,fsrs_state) VALUES('word','valid','有效',?,?,1,5,?)")
			.run(lastReview, new Date(0).toISOString(), state);
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1 WHERE id=1").run();
		db.close();
		await harness.commands["anki:good"].handler("", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT reviews,fsrs_status,fsrs_error FROM items WHERE id=1").get() as any;
		const corruptions = Number((check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any).n);
		check.close();
		assert.equal(item.reviews, 6, "valid FSRS state advances normally");
		assert.equal(item.fsrs_status, "ok");
		assert.equal(item.fsrs_error, null);
		assert.equal(corruptions, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("corrupt FSRS state quarantines the card without silent reset", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "corrupt-test" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word','bad','坏',?,?,1,'NOT_JSON')").run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1 WHERE id=1").run();
		db.close();
		await harness.commands["anki:good"].handler("", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT fsrs_status, fsrs_error FROM items WHERE id=1").get() as any;
		const corrupt = check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(item.fsrs_status, "corrupt");
		assert.ok(item.fsrs_error, "error code recorded");
		assert.equal(corrupt.n, 1, "one diagnostic row");
		assert.equal(active.active_item_id, null, "active slot cleared");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("non-object and invalid-date FSRS states are quarantined without throwing", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const validDate = new Date().toISOString();
		const cases = [
			{ state: "null", error: /not_object/ },
			{
				state: JSON.stringify({ due: "not-a-date", last_review: "not-a-date", stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 1 }),
				error: /invalid_date/,
			},
			{
				state: JSON.stringify({ due: validDate, last_review: validDate, stability: -1, difficulty: 1, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 2 }),
				error: /invalid_field:fsrs_range/,
			},
			{
				state: JSON.stringify({ due: validDate, last_review: validDate, stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 999 }),
				error: /invalid_field:state/,
			},
		];
		for (const [index, fixture] of cases.entries()) {
			const harness = await createHarness({ sessionId: `corrupt-structure-${index}` });
			const db = openTestDb();
			const now = new Date().toISOString();
			db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word',?,?,?, ?,1,?)")
				.run(`bad-${index}`, "坏", now, new Date(0).toISOString(), fixture.state);
			db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1 WHERE id=1").run();
			db.close();
			await harness.commands["anki:good"].handler("", harness.ctx);
			const check = openTestDb();
			const item = check.prepare("SELECT fsrs_status,fsrs_error FROM items WHERE id=1").get() as any;
			const count = Number((check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any).n);
			check.close();
			assert.equal(item.fsrs_status, "corrupt");
			assert.match(item.fsrs_error, fixture.error);
			assert.equal(count, 1);
			await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		}
	} finally {
		fake.restore();
	}
});

test("two sessions quarantine the same corrupt FSRS item only once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ sessionId: "corrupt-race-a" });
		const b = await makeSession({ sessionId: "corrupt-race-b" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word','bad','坏',?,?,1,'NOT_JSON')").run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1 WHERE id=1").run();
		db.close();
		await Promise.all([
			a.commands["anki:good"].handler("", a.ctx),
			b.commands["anki:good"].handler("", b.ctx),
		]);
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any).n);
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(count, 1);
		assert.equal(state.active_item_id, null);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("word/phrase evaluator unavailable keeps card pending with zero writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "eval-pending" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','hello','你好',?,?,1)").run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("wrong", harness.ctx);
		assert.ok(harness.notifications().some((m) => /无法可靠判断/.test(m)));
		const check = openTestDb();
		const att = check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(att.n, 0, "zero attempts");
		assert.equal(active.active_item_id, 1, "card stays pending");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));

// -- P0-2 assistance-aware scheduling (harness level) ----------------------

test("hint-assisted correct answer schedules Hard and says so", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','apple','苹果',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:hint"].handler("", harness.ctx);
		await harness.commands["anki:answer"].handler("apple", harness.ctx);
		assert.match(harness.widget().join(" "), /记了个大概（用了提示，按困难安排）/);
		const check = openTestDb();
		const attempt = check.prepare("SELECT assistance_level, verdict, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT unassisted_good, assisted_good FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...attempt }, { assistance_level: "hint", verdict: "correct", explicit_rating: "hard" });
		assert.deepEqual({ ...mastery }, { unassisted_good: 0, assisted_good: 1 }, "hint-correct is assisted evidence, never unassisted");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("manual /anki:good is recorded as a conservative self-report, not objective evidence", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','banana','香蕉',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:good"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /自评兜底，按困难保守安排/);
		const check = openTestDb();
		const attempt = check.prepare("SELECT kind, status, explicit_rating, assistance_level, question_text FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT stage, unassisted_good, assisted_good FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...attempt }, { kind: "recall_self_report", status: "self_report", explicit_rating: "hard", assistance_level: "none", question_text: "默写单词「香蕉」的英文" });
		assert.deepEqual({ ...mastery }, { stage: "exposure", unassisted_good: 0, assisted_good: 0 }, "self-report produces no objective evidence");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("word/phrase assistance persists across sessions (hint in A, answered in B still caps Hard)", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "assist-a" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','cherry','樱桃',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await a.commands["anki:hint"].handler("", a.ctx);
		// B attaches after the hint: it must still see assistance=hint.
		const b = await makeSession({ sessionId: "assist-b" });
		await b.commands["anki:answer"].handler("cherry", b.ctx);
		const check = openTestDb();
		const attempt = check.prepare("SELECT assistance_level, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...attempt }, { assistance_level: "hint", explicit_rating: "hard" }, "assistance survived reattachment and capped the rating");
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

// -- P0-1 direction-independent scheduling (harness level) -----------------

test("after a forward Again, a due reverse surfaces in reverse direction", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','grape','葡萄',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /默写单词「葡萄」的英文/, "first surfacing defaults to forward production");
		await harness.commands["anki:again"].handler("", harness.ctx);
		// Forward was just rated (due soon); simulate time passing so only the
		// reverse direction is due, and the item itself is due again.
		const db2 = openTestDb();
		db2.prepare("UPDATE direction_state SET due_at = ? WHERE item_id = 1 AND direction = 'forward'").run("2099-01-01T00:00:00.000Z");
		db2.prepare("UPDATE direction_state SET due_at = ? WHERE item_id = 1 AND direction = 'reverse'").run(new Date(0).toISOString());
		db2.prepare("UPDATE items SET due_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.prepare("UPDATE runtime_state SET active_item_id = NULL, next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /写出单词「grape」的中文释义/, "the due reverse direction surfaces, not a random one");
		const check = openTestDb();
		const state = check.prepare("SELECT active_direction FROM runtime_state WHERE id = 1").get() as any;
		const dirs = check.prepare("SELECT direction, fsrs_state FROM direction_state WHERE item_id = 1 ORDER BY direction").all() as any[];
		check.close();
		assert.equal(state.active_direction, "reverse");
		assert.ok(dirs.every((d) => typeof d.fsrs_state === "string"), "both direction rows exist after the first rating");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});
