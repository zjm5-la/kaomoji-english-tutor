// /anki:add custom-card queue: migration, FIFO staging, quota accounting,
// partial lesson batches, custom generation, and critic composition.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiSdkLlmClient } from "../pi-sdk-llm.ts";
import type { PetConfig } from "../config.ts";
import type { AdaptiveContext } from "../learner-profile.ts";
import type { GeneratedItem } from "../llm.ts";
import { coldStartProfile, deriveBudget } from "../learner-profile.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "kaomoji-custom-queue-"));

const { MAX_CUSTOM_PER_ADD } = await import("../config.ts");
const {
	contentFingerprint,
	countTodayNew,
	customQueueCount,
	enqueueCustomCard,
	insertItem,
	listCustomQueue,
	openDb,
	peekCustomQueue,
	removeCustomQueueRows,
} = await import("../db.ts");
const {
	critiqueLesson,
	generateCustomCards,
	generateLesson,
} = await import("../llm.ts");
const { formatStatusLine } = await import("../render.ts");

const FAKE_CTX = {} as ExtensionContext;
const FAKE_CONFIG = { maxTokens: 900, thinkingLevel: "off" } as unknown as PetConfig;
const ADAPTIVE: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };

/** LLM mock returning canned JSON for every complete() call. */
function mockLlm(response: () => string, captured: { prompt?: string } = {}): PiSdkLlmClient {
	return {
		complete: async (_ctx: unknown, _resolved: unknown, request: { prompt: string }) => {
			captured.prompt = request.prompt;
			return response();
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
}

function word(text: string, meaning = `释义 ${text}`): GeneratedItem {
	return { type: "word", text, meaning, phonetic: "/x/", example: `The ${text} runs.`, example_cn: `${text} 在跑。` };
}

function wordJson(text: string, meaning = `释义 ${text}`): unknown {
	return { type: "word", text, meaning, phonetic: "/x/", example: `The ${text} runs.`, example_cn: `${text} 在跑。` };
}

// -- db: migration + FIFO queue ------------------------------------------------

test("v12 migration creates custom_card_queue and registers schema version 12", () => {
	const db = openDb();
	try {
		const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_card_queue'").get() as { name: string } | undefined;
		assert.ok(table, "custom_card_queue exists");
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as { schema_version: number };
		assert.equal(meta.schema_version, 12);
		const migrations = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);
		assert.equal(migrations[migrations.length - 1], 12);
	} finally {
		db.close();
	}
});

test("enqueue/peek/remove keep FIFO order and stage fingerprints", () => {
	const db = openDb();
	try {
		enqueueCustomCard(db, "p1", word("alpha"));
		enqueueCustomCard(db, "p2", word("beta"));
		enqueueCustomCard(db, "p3", word("gamma"));
		assert.equal(customQueueCount(db), 3);

		const firstTwo = peekCustomQueue(db, 2);
		assert.deepEqual(
			firstTwo.map((row) => (JSON.parse(row.payload) as GeneratedItem).text),
			["alpha", "beta"],
			"peek returns oldest rows first",
		);
		assert.equal(firstTwo[0].fingerprint, contentFingerprint("word", "alpha", "释义 alpha"));
		assert.equal(firstTwo[0].prompt, "p1");

		removeCustomQueueRows(db, firstTwo.map((row) => row.id));
		assert.deepEqual(
			listCustomQueue(db).map((row) => (JSON.parse(row.payload) as GeneratedItem).text),
			["gamma"],
			"FIFO order preserved after removal",
		);
		assert.equal(customQueueCount(db), 1);
	} finally {
		db.close();
	}
});

test("countTodayNew counts custom introductions alongside planned", () => {
	const db = openDb();
	try {
		const now = new Date();
		const customId = insertItem(db, "word", "queueword", null, "排队词", null, null, now, { introductionKind: "custom" });
		const plannedId = insertItem(db, "word", "planword", null, "计划词", null, null, now, { introductionKind: "planned" });
		assert.equal(countTodayNew(db, now), 0, "not yet introduced");
		db.prepare("UPDATE items SET introduced_at = ? WHERE id IN (?, ?)").run(now.toISOString(), customId, plannedId);
		assert.equal(countTodayNew(db, now), 2, "planned + custom both counted");
	} finally {
		db.close();
	}
});

// -- llm: partial lesson batches -------------------------------------------------

test("generateLesson partial batch accepts exactly 4 word items and rejects 5", async () => {
	const four = JSON.stringify({ ready: true, topic: "t", items: [0, 1, 2, 3].map((i) => wordJson(`fox${i}`)) });
	const decision = await generateLesson(
		mockLlm(() => four), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
		{ wordItems: 4, clozeItems: 0 },
	);
	assert.equal(decision.ready, true);
	assert.ok(decision.ready);
	assert.equal(decision.items.length, 4);

	const five = JSON.stringify({ ready: true, topic: "t", items: [0, 1, 2, 3, 4].map((i) => wordJson(`fox${i}`)) });
	await assert.rejects(
		generateLesson(
			mockLlm(() => five), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
			"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
			{ wordItems: 4, clozeItems: 0 },
		),
		/INVALID_LESSON_SHAPE/,
	);
});

test("generateLesson partial batch enforces the scaled phrase cap and word floor", async () => {
	// 4 phrases with wordItems=4: cap = min(3, 4) = 3 -> rejected by the objective gate.
	const fourPhrases = JSON.stringify({
		ready: true, topic: "t",
		items: [0, 1, 2, 3].map((i) => ({ ...wordJson(`lazy dog ${i}`), type: "phrase" })),
	});
	await assert.rejects(
		generateLesson(
			mockLlm(() => fourPhrases), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
			"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
			{ wordItems: 4, clozeItems: 0 },
		),
		/INVALID_LESSON_SHAPE/,
	);
	// 1 word + 1 phrase with wordItems=2: cap = min(3, 2) = 2 -> accepted.
	const mixed = JSON.stringify({
		ready: true, topic: "t",
		items: [wordJson("fox"), { ...wordJson("lazy dog"), type: "phrase" }],
	});
	const decision = await generateLesson(
		mockLlm(() => mixed), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
		{ wordItems: 2, clozeItems: 0 },
	);
	assert.ok(decision.ready);
});

// -- llm: generateCustomCards ------------------------------------------------------

test("generateCustomCards parses valid items and passes the prompt through", async () => {
	const captured: { prompt?: string } = {};
	const response = JSON.stringify({ ready: true, items: [wordJson("menu"), wordJson("order"), wordJson("bill")] });
	const decision = await generateCustomCards(
		mockLlm(() => response, captured), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		"3 张餐厅点餐词汇", [], FAKE_CONFIG, ADAPTIVE,
	);
	assert.ok(decision.ready);
	assert.equal(decision.items.length, 3);
	assert.match(captured.prompt!, /<user_request>\n3 张餐厅点餐词汇\n<\/user_request>/);
	assert.match(captured.prompt!, new RegExp(String(MAX_CUSTOM_PER_ADD)));
	assert.match(captured.prompt!, /learner_profile/);
});

test("generateCustomCards clamps oversized batches to MAX_CUSTOM_PER_ADD", async () => {
	const items = Array.from({ length: MAX_CUSTOM_PER_ADD + 5 }, (_, i) => wordJson(`word${i}`));
	const decision = await generateCustomCards(
		mockLlm(() => JSON.stringify({ ready: true, items })), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		"25 张旅行词汇", [], FAKE_CONFIG, ADAPTIVE,
	);
	assert.ok(decision.ready);
	assert.equal(decision.items.length, MAX_CUSTOM_PER_ADD);
});

test("generateCustomCards rejects sentence items and in-batch duplicates", async () => {
	const sentence = {
		type: "sentence", text: "The menu is long today.", meaning: "句",
		levels: ["a", "b", "c"], levels_cn: ["x", "y", "z"], chunks: ["a", "b"],
	};
	await assert.rejects(
		generateCustomCards(
			mockLlm(() => JSON.stringify({ ready: true, items: [wordJson("menu"), sentence] })),
			FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "x", [], FAKE_CONFIG, ADAPTIVE,
		),
		/INVALID_CUSTOM_ITEM/,
	);
	await assert.rejects(
		generateCustomCards(
			mockLlm(() => JSON.stringify({ ready: true, items: [wordJson("menu"), wordJson("Menu")] })),
			FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "x", [], FAKE_CONFIG, ADAPTIVE,
		),
		/INVALID_CUSTOM_ITEM/,
	);
});

test("generateCustomCards surfaces an LLM refusal with its reason", async () => {
	const decision = await generateCustomCards(
		mockLlm(() => JSON.stringify({ ready: false, reason: "提示词太空泛" })),
		FAKE_CTX, { provider: "p", model: "m", fromSession: false }, "嗯", [], FAKE_CONFIG, ADAPTIVE,
	);
	assert.deepEqual(decision, { ready: false, reason: "提示词太空泛" });
});

// -- llm: critic composition -------------------------------------------------------

test("critiqueLesson custom composition skips the fixed-composition gate", async () => {
	// 11 items with 5 phrases trip the default full-batch composition rule...
	const items: GeneratedItem[] = [];
	for (let i = 0; i < 6; i++) items.push(word(`fox${i}`));
	for (let i = 0; i < 5; i++) items.push({ ...word(`lazy dog ${i}`), type: "phrase" });
	const passLlm = mockLlm(() => JSON.stringify({ pass: true, issues: [], summary: "ok" }));

	const defaultVerdict = await critiqueLesson(
		passLlm, FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		{ topic: "t", items }, [], FAKE_CONFIG, ADAPTIVE,
	);
	assert.equal(defaultVerdict.pass, false, "default composition gate rejects 5 phrases");
	assert.ok(defaultVerdict.issues.some((i) => i.category === "composition"));

	// ...but a custom batch (composition === null) must not be judged by it.
	const customVerdict = await critiqueLesson(
		passLlm, FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		{ topic: "t", items }, [], FAKE_CONFIG, ADAPTIVE, null,
	);
	assert.equal(customVerdict.pass, true, "custom composition descriptor bypasses the fixed gate");
});

test("critiqueLesson explicit partial composition still enforces its own cap", async () => {
	const items = [0, 1, 2, 3].map((i) => ({ ...word(`lazy dog ${i}`), type: "phrase" }) as GeneratedItem);
	let calls = 0;
	const llm = mockLlm(() => { calls++; return JSON.stringify({ pass: true, issues: [], summary: "ok" }); });
	const verdict = await critiqueLesson(
		llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		{ topic: "t", items }, [], FAKE_CONFIG, ADAPTIVE, { wordItems: 4, clozeItems: 0 },
	);
	assert.equal(verdict.pass, false);
	assert.ok(verdict.issues.some((i) => i.category === "composition"));
	assert.equal(calls, 0, "deterministic gate short-circuits before the LLM critic");
});

// -- render: status line queue badge ---------------------------------------------

test("formatStatusLine appends the queue badge only when cards are queued", () => {
	const db = openDb();
	try {
		db.exec("DELETE FROM items; DELETE FROM custom_card_queue;");
		assert.equal(formatStatusLine(db, 11), "", "nothing left and empty queue -> no line");
		enqueueCustomCard(db, "p", word("alpha"));
		enqueueCustomCard(db, "p", word("beta"));
		const line = formatStatusLine(db, 11);
		assert.match(line, /排队 2/);
		assert.doesNotMatch(line, /今日剩余卡片/);
	} finally {
		db.close();
	}
});
