// Sync tests: git-backed whole-DB sync against a local bare remote (no network).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "kaomoji-sync-test-"));
const agentDirA = join(root, "agentA");
const agentDirB = join(root, "agentB");
mkdirSync(agentDirA);
mkdirSync(agentDirB);
process.env.PI_CODING_AGENT_DIR = agentDirA;

const { insertItem, openDb, touchClient } = await import("../db.ts");
const { activityTs, dbFilePath, pullIfNewer, pushSnapshot } = await import("../sync.ts");

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const remoteDir = join(root, "remote.git");
const syncA = join(root, "syncA");
const syncB = join(root, "syncB");
execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
execFileSync("git", ["clone", remoteDir, syncA]);
execFileSync("git", ["clone", remoteDir, syncB]);

function insertWord(db: Parameters<typeof insertItem>[0], text: string, at: string) {
	return insertItem(db, "word", text, null, "释义", null, null, new Date(at));
}

test("activityTs: null on empty db, learned_at after insert", () => {
	process.env.PI_CODING_AGENT_DIR = agentDirA;
	const db = openDb();
	try {
		assert.equal(activityTs(db), null);
		insertWord(db, "alpha", "2026-08-15T08:00:00.000Z");
		assert.equal(activityTs(db), "2026-08-15T08:00:00.000Z");
	} finally {
		db.close();
	}
});

test("push: disabled without repo, then pushed/unchanged/throttled cycle", async () => {
	process.env.KAOMOJI_SYNC_DIR = join(root, "nonexistent");
	process.env.PI_CODING_AGENT_DIR = agentDirA;
	const db = openDb();
	try {
		assert.equal((await pushSnapshot(db)).status, "disabled");
		process.env.KAOMOJI_SYNC_DIR = syncA;
		assert.equal((await pushSnapshot(db)).status, "pushed");
		// No new activity since the push.
		assert.equal((await pushSnapshot(db)).status, "unchanged");
		// New activity within the 30-min window is throttled, unless forced.
		insertWord(db, "beta", "2026-08-15T09:00:00.000Z");
		assert.equal((await pushSnapshot(db)).status, "throttled");
		assert.equal((await pushSnapshot(db, { ignoreThrottle: true })).status, "pushed");
		const log = git(syncA, ["log", "--oneline"]);
		assert.equal(log.trim().split("\n").length, 2);
	} finally {
		db.close();
	}
});

test("two-machine round trip: pull replaces with newer remote, keeps .bak", async () => {
	// Machine B starts fresh and pulls machine A's snapshot.
	process.env.PI_CODING_AGENT_DIR = agentDirB;
	process.env.KAOMOJI_SYNC_DIR = syncB;
	const pullB = await pullIfNewer(dbFilePath());
	assert.equal(pullB.status, "pulled");
	const dbB = openDb();
	const textB = (dbB.prepare("SELECT text FROM items ORDER BY id").all() as { text: string }[]).map((r) => r.text);
	assert.deepEqual(textB, ["alpha", "beta"]);
	// B learns something newer and pushes it.
	insertWord(dbB, "gamma", "2026-08-15T10:00:00.000Z");
	assert.equal((await pushSnapshot(dbB, { ignoreThrottle: true })).status, "pushed");
	dbB.close();

	// A still holds the older state: push is refused, pull upgrades with a .bak fallback.
	process.env.PI_CODING_AGENT_DIR = agentDirA;
	process.env.KAOMOJI_SYNC_DIR = syncA;
	const dbA = openDb();
	try {
		assert.equal((await pushSnapshot(dbA, { ignoreThrottle: true })).status, "remote_newer");
	} finally {
		dbA.close();
	}
	const pullA = await pullIfNewer(dbFilePath());
	assert.equal(pullA.status, "pulled");
	const dbA2 = openDb();
	try {
		const texts = (dbA2.prepare("SELECT text FROM items ORDER BY id").all() as { text: string }[]).map((r) => r.text);
		assert.deepEqual(texts, ["alpha", "beta", "gamma"]);
	} finally {
		dbA2.close();
	}
	assert.ok(readdirSync(agentDirA).some((f) => f.startsWith("kaomoji-english-tutor.db.bak-")));
	// Pulling again is a no-op.
	assert.equal((await pullIfNewer(dbFilePath())).status, "current");
});

test("pull skipped while another local session is live", async () => {
	// Machine B pushes newer data.
	process.env.PI_CODING_AGENT_DIR = agentDirB;
	process.env.KAOMOJI_SYNC_DIR = syncB;
	const dbB = openDb();
	insertWord(dbB, "delta", "2026-08-15T11:00:00.000Z");
	assert.equal((await pushSnapshot(dbB, { ignoreThrottle: true })).status, "pushed");
	dbB.close();

	// Machine A has a live session (fresh heartbeat) → pull must not swap the file under it.
	process.env.PI_CODING_AGENT_DIR = agentDirA;
	process.env.KAOMOJI_SYNC_DIR = syncA;
	const dbA = openDb();
	touchClient(dbA, "live-session");
	dbA.close();
	const pull = await pullIfNewer(dbFilePath());
	assert.equal(pull.status, "skipped_active_session");
	assert.ok(existsSync(join(syncA, "kaomoji-english-tutor.db")));
});
