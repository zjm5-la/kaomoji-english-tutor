import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { claimJob, createJob, finalizePhase, getJob, reapExpiredJobs, writeArtifact } from "../jobs.ts";

/** Fresh in-memory database with just the tutor_jobs tables. */
function openDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE IF NOT EXISTS tutor_jobs (
			id TEXT PRIMARY KEY, purpose TEXT NOT NULL,
			job_key TEXT NOT NULL UNIQUE, snapshot_hash TEXT NOT NULL,
			pipeline_version INTEGER NOT NULL, phase TEXT NOT NULL,
			status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
			attempt_count INTEGER NOT NULL DEFAULT 0, next_run_at TEXT NOT NULL,
			owner TEXT, lease_token TEXT, lease_until TEXT,
			artifacts_json TEXT NOT NULL DEFAULT '{}', failure_json TEXT,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tutor_job_artifacts (
			job_id TEXT NOT NULL, job_version INTEGER NOT NULL, phase TEXT NOT NULL,
			artifact_key TEXT NOT NULL, input_hash TEXT, status TEXT NOT NULL,
			payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
			PRIMARY KEY (job_id, job_version, phase, artifact_key)
		);
	`);
	return db;
}

const baseParams = { purpose: "lesson", jobKey: "k1", snapshotHash: "h", pipelineVersion: 1, phase: "generate" as const };

test("createJob is idempotent by job_key", () => {
	const db = openDb();
	try {
		const now = new Date();
		const id1 = createJob(db, { ...baseParams, now });
		const id2 = createJob(db, { ...baseParams, now });
		const id3 = createJob(db, { ...baseParams, jobKey: "k2", now });
		assert.equal(id1, id2);
		assert.notEqual(id1, id3);
	} finally { db.close(); }
});

test("claimJob is exclusive: only one caller wins the lease", () => {
	const db = openDb();
	try {
		const now = new Date(1000);
		const id = createJob(db, { ...baseParams, now });
		const leaseUntil = new Date(now.getTime() + 60000);
		const t1 = randomUUID();
		const t2 = randomUUID();
		assert.equal(claimJob(db, id, "owner-A", t1, leaseUntil, now), true);
		assert.equal(claimJob(db, id, "owner-B", t2, leaseUntil, now), false);
		const job = getJob(db, id)!;
		assert.equal(job.owner, "owner-A");
		assert.equal(job.status, "running");
		assert.equal(job.attempt_count, 1);
	} finally { db.close(); }
});

test("an expired lease can be reclaimed by a new owner", () => {
	const db = openDb();
	try {
		const t0 = new Date(1000);
		const id = createJob(db, { ...baseParams, now: t0 });
		const leaseUntil = new Date(2000);
		const t1 = randomUUID();
		assert.equal(claimJob(db, id, "owner-A", t1, leaseUntil, t0), true);
		// Time has moved past the lease expiry.
		const now = new Date(3000);
		const t2 = randomUUID();
		assert.equal(claimJob(db, id, "owner-B", t2, new Date(4000), now), true);
		assert.equal(getJob(db, id)!.owner, "owner-B");
	} finally { db.close(); }
});

test("finalizePhase advances the phase only for the lease holder with matching version", () => {
	const db = openDb();
	try {
		const now = new Date(1000);
		const id = createJob(db, { ...baseParams, now });
		const token = randomUUID();
		claimJob(db, id, "owner", token, new Date(now.getTime() + 60000), now);
		const versionAtClaim = getJob(db, id)!.version;
		// Correct version + token → succeeds.
		assert.equal(
			finalizePhase(db, id, versionAtClaim, token, {
				phase: "critique", status: "ready", artifactsJson: "{}", failureJson: null, nextRunAt: now.toISOString(),
			}, now),
			true,
		);
		const after = getJob(db, id)!;
		assert.equal(after.phase, "critique");
		assert.equal(after.status, "ready");
		assert.equal(after.lease_token, null);
		// Stale version → rejected.
		assert.equal(
			finalizePhase(db, id, versionAtClaim, token, {
				phase: "finalize", status: "committed", artifactsJson: "{}", failureJson: null, nextRunAt: now.toISOString(),
			}, now),
			false,
		);
		// Wrong token → rejected.
		assert.equal(
			finalizePhase(db, id, after.version, "wrong-token", {
				phase: "finalize", status: "committed", artifactsJson: "{}", failureJson: null, nextRunAt: now.toISOString(),
			}, now),
			false,
		);
	} finally { db.close(); }
});

test("finalizePhase rejects an expired lease before reap", () => {
	const db = openDb();
	try {
		const claimedAt = new Date(1000);
		const id = createJob(db, { ...baseParams, now: claimedAt });
		const token = randomUUID();
		claimJob(db, id, "owner", token, new Date(2000), claimedAt);
		const versionAtClaim = getJob(db, id)!.version;
		assert.equal(
			finalizePhase(db, id, versionAtClaim, token, {
				phase: "critique", status: "ready", artifactsJson: "{}", failureJson: null, nextRunAt: new Date(3000).toISOString(),
			}, new Date(3000)),
			false,
		);
		const job = getJob(db, id)!;
		assert.equal(job.status, "running");
		assert.equal(job.phase, "generate");
	} finally { db.close(); }
});

test("writeArtifact is idempotent and does not bump the parent version", () => {
	const db = openDb();
	try {
		const now = new Date(1000);
		const id = createJob(db, { ...baseParams, now });
		const token = randomUUID();
		claimJob(db, id, "owner", token, new Date(now.getTime() + 60000), now);
		const versionAtClaim = getJob(db, id)!.version;
		assert.equal(writeArtifact(db, id, versionAtClaim, "generate", "candidate-0", "ih", "{}", now), true);
		assert.equal(writeArtifact(db, id, versionAtClaim, "generate", "candidate-0", "ih", "{}", now), false);
		const n = (db.prepare("SELECT COUNT(*) AS n FROM tutor_job_artifacts").get() as { n: number }).n;
		assert.equal(n, 1);
		// Parent version untouched by artifact writes.
		assert.equal(getJob(db, id)!.version, versionAtClaim);
	} finally { db.close(); }
});

test("reapExpiredJobs releases expired leases back to queued", () => {
	const db = openDb();
	try {
		const t0 = new Date(1000);
		const id = createJob(db, { ...baseParams, now: t0 });
		claimJob(db, id, "owner", randomUUID(), new Date(2000), t0);
		// Lease (2000) still valid at t=1500.
		assert.equal(reapExpiredJobs(db, new Date(1500)), 0);
		// Lease expired by t=3000.
		assert.equal(reapExpiredJobs(db, new Date(3000)), 1);
		const job = getJob(db, id)!;
		assert.equal(job.status, "queued");
		assert.equal(job.owner, null);
		assert.equal(job.lease_token, null);
	} finally { db.close(); }
});
