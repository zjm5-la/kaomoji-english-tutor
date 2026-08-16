// sync.ts — Git-backed whole-DB cloud sync for sequential multi-machine use.
//
// Backend: a private git repo cloned at ~/.pi/agent/kaomoji-english-tutor-sync
// (override with KAOMOJI_SYNC_DIR, e.g. in tests). Push snapshots the whole
// SQLite DB via VACUUM INTO and commits it; pull replaces the local file when
// the remote snapshot holds newer learning activity, keeping a timestamped
// .bak fallback. Row-level merge is intentionally out of scope: autoincrement
// ids collide across machines and usage is sequential (last writer wins).

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getStat, setStat } from "./db.ts";

export const SYNC_DB_FILENAME = "kaomoji-english-tutor.db";
const MIN_PUSH_INTERVAL_MS = 30 * 60_000;
const LOCK_STALE_MS = 5 * 60_000;
const LIVE_CLIENT_MS = 150_000;

export interface SyncResult {
	status: string;
	message?: string;
	localTs?: string | null;
	remoteTs?: string | null;
}

export function syncDir(): string {
	return process.env.KAOMOJI_SYNC_DIR || join(getAgentDir(), "kaomoji-english-tutor-sync");
}

export function dbFilePath(): string {
	return join(getAgentDir(), SYNC_DB_FILENAME);
}

export function isSyncEnabled(): boolean {
	return existsSync(join(syncDir(), ".git"));
}

/** Latest learning-activity timestamp across items and attempts (ISO strings compare lexicographically). */
export function activityTs(db: DatabaseSync): string | null {
	const row = db
		.prepare(
			`SELECT MAX(ts) AS ts FROM (
				SELECT MAX(learned_at) AS ts FROM items
				UNION ALL SELECT MAX(introduced_at) FROM items
				UNION ALL SELECT MAX(completed_at) FROM attempts)`,
		)
		.get() as { ts: string | null } | undefined;
	return row?.ts ?? null;
}

function activityTsFromFile(path: string): { ts: string | null; liveClients: boolean } {
	if (!existsSync(path)) return { ts: null, liveClients: false };
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		const ts = activityTs(db);
		const cutoff = new Date(Date.now() - LIVE_CLIENT_MS).toISOString();
		const clients = db
			.prepare("SELECT COUNT(*) AS n FROM runtime_clients WHERE last_seen > ?")
			.get(cutoff) as { n: number } | undefined;
		return { ts, liveClients: (clients?.n ?? 0) > 0 };
	} catch {
		return { ts: null, liveClients: false };
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
}

function activityTsFromBuffer(buf: Buffer): string | null {
	const tmp = join(tmpdir(), `kaomoji-sync-${process.pid}-${Date.now()}.db`);
	try {
		writeFileSync(tmp, buf);
		return activityTsFromFile(tmp).ts;
	} finally {
		rmSync(tmp, { force: true });
	}
}

function git(args: string[], timeoutMs: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "user.name=kaomoji-sync", "-c", "user.email=kaomoji-sync@local", ...args],
			{ cwd: syncDir(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
			(err, stdout, stderr) => {
				if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 200)));
				else resolve(stdout);
			},
		);
	});
}

/** Remote snapshot bytes, or null when the remote branch/file does not exist or fetch failed. */
async function fetchRemoteDb(): Promise<Buffer | null> {
	try {
		await git(["fetch", "origin", "main"], 12_000);
		return await git(["show", `FETCH_HEAD:${SYNC_DB_FILENAME}`], 10_000);
	} catch {
		return null;
	}
}

function lockPath(): string {
	return join(syncDir(), ".sync.lock");
}

function acquireLock(): boolean {
	try {
		if (Date.now() - Date.parse(readFileSync(lockPath(), "utf8")) < LOCK_STALE_MS) return false;
	} catch { /* no (valid) lock */ }
	writeFileSync(lockPath(), new Date().toISOString());
	return true;
}

function releaseLock(): void {
	rmSync(lockPath(), { force: true });
}

/**
 * Replace the local DB with the remote snapshot when it holds newer activity.
 * Skipped while another local session is live (its heartbeats prove it owns fresher state).
 * Runs before openDb in session_start, so no local connection is held by this session.
 */
export async function pullIfNewer(localDbPath = dbFilePath(), opts: { force?: boolean } = {}): Promise<SyncResult> {
	if (!isSyncEnabled()) return { status: "disabled" };
	if (!acquireLock()) return { status: "locked" };
	try {
		// Cheap local check first: never touch the network when a live local
		// session makes replacing the file unsafe anyway (unless forced).
		const local = activityTsFromFile(localDbPath);
		if (local.liveClients && !opts.force) return { status: "skipped_active_session", localTs: local.ts };
		const remoteBuf = await fetchRemoteDb();
		if (!remoteBuf) return { status: "no_remote" };
		const remoteTs = activityTsFromBuffer(remoteBuf);
		if (!remoteTs) return { status: "no_remote" };
		if (local.ts && remoteTs <= local.ts) return { status: "current", localTs: local.ts, remoteTs };
		if (existsSync(localDbPath)) {
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			copyFileSync(localDbPath, `${localDbPath}.bak-${stamp}`);
		}
		writeFileSync(localDbPath, remoteBuf);
		// The snapshot is a fresh non-WAL file; drop stale sidecars so they cannot replay.
		rmSync(`${localDbPath}-wal`, { force: true });
		rmSync(`${localDbPath}-shm`, { force: true });
		return { status: "pulled", localTs: local.ts, remoteTs };
	} catch (err) {
		return { status: "error", message: String((err as Error)?.message || err) };
	} finally {
		releaseLock();
	}
}

/**
 * Non-destructive remote check: reports whether the cloud snapshot holds newer
 * activity without replacing or locking out anything. Used for background
 * nudges; /anki:pull performs the actual swap.
 */
export async function peekRemoteNewer(localDbPath = dbFilePath()): Promise<{ remoteNewer: boolean; remoteTs: string | null }> {
	if (!isSyncEnabled()) return { remoteNewer: false, remoteTs: null };
	if (!acquireLock()) return { remoteNewer: false, remoteTs: null };
	try {
		const local = activityTsFromFile(localDbPath);
		const remoteBuf = await fetchRemoteDb();
		const remoteTs = remoteBuf ? activityTsFromBuffer(remoteBuf) : null;
		return { remoteNewer: Boolean(remoteTs && (!local.ts || remoteTs > local.ts)), remoteTs };
	} catch {
		return { remoteNewer: false, remoteTs: null };
	} finally {
		releaseLock();
	}
}

/**
 * Push a consistent snapshot of the local DB when activity changed.
 * Refuses when the remote holds newer activity (pull/reload first instead of
 * clobbering it). Throttled to one push per 30 min unless ignoreThrottle.
 */
export async function pushSnapshot(db: DatabaseSync, opts: { ignoreThrottle?: boolean } = {}): Promise<SyncResult> {
	if (!isSyncEnabled()) return { status: "disabled" };
	const localTs = activityTs(db);
	if (!opts.ignoreThrottle) {
		if ((localTs ?? "") === (getStat(db, "sync_last_activity") ?? "")) return { status: "unchanged" };
		const lastPush = Number(getStat(db, "sync_last_push_at") ?? 0);
		if (Date.now() - lastPush < MIN_PUSH_INTERVAL_MS) return { status: "throttled" };
	}
	if (!acquireLock()) return { status: "locked" };
	try {
		const remoteBuf = await fetchRemoteDb();
		const remoteTs = remoteBuf ? activityTsFromBuffer(remoteBuf) : null;
		if (remoteTs && (!localTs || remoteTs > localTs)) {
			return { status: "remote_newer", localTs, remoteTs };
		}
		if (remoteBuf) await git(["reset", "--hard", "FETCH_HEAD"], 10_000);
		const target = join(syncDir(), SYNC_DB_FILENAME);
		rmSync(target, { force: true });
		db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
		await git(["add", SYNC_DB_FILENAME], 5_000);
		const porcelain = (await git(["status", "--porcelain", SYNC_DB_FILENAME], 5_000)).toString().trim();
		if (!porcelain) {
			setStat(db, "sync_last_activity", localTs ?? "");
			return { status: "unchanged" };
		}
		await git(["commit", "-m", `sync ${localTs ?? new Date().toISOString()}`], 5_000);
		await git(["push", "origin", "main"], 25_000);
		setStat(db, "sync_last_activity", localTs ?? "");
		setStat(db, "sync_last_push_at", String(Date.now()));
		return { status: "pushed", localTs, remoteTs };
	} catch (err) {
		return { status: "error", message: String((err as Error)?.message || err) };
	} finally {
		releaseLock();
	}
}
