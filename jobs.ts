import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Durable, recoverable tutor-job machinery. A job is a multi-phase LLM
 * pipeline (diagnose → plan → generate → critique → revise → finalize) whose
 * progress is persisted so a crash or reload can resume from the last
 * completed phase instead of redoing (or losing) the whole run.
 *
 * Concurrency contract:
 *   - `claimJob` takes an exclusive lease via a single conditional UPDATE.
 *   - `writeArtifact` is idempotent (INSERT OR IGNORE) and never touches the
 *     parent job version, so parallel candidate/critic callbacks cannot race.
 *   - `finalizePhase` is a CAS on (id, version, lease_token); only the lease
 *     holder advances the phase.
 */

export type JobStatus = "queued" | "running" | "ready" | "deferred" | "committed" | "stale" | "failed";
export type JobPhase = "diagnose" | "plan" | "generate" | "critique" | "revise" | "finalize";

export interface TutorJob {
	id: string;
	purpose: string;
	job_key: string;
	snapshot_hash: string;
	pipeline_version: number;
	phase: JobPhase;
	status: JobStatus;
	version: number;
	attempt_count: number;
	next_run_at: string;
	owner: string | null;
	lease_token: string | null;
	lease_until: string | null;
	artifacts_json: string;
	failure_json: string | null;
	created_at: string;
	updated_at: string;
}

/** Find an existing job by its unique job_key. */
export function findJobByKey(db: DatabaseSync, jobKey: string): TutorJob | undefined {
	return db.prepare("SELECT * FROM tutor_jobs WHERE job_key = ?").get(jobKey) as TutorJob | undefined;
}

/** Get a job by id. */
export function getJob(db: DatabaseSync, id: string): TutorJob | undefined {
	return db.prepare("SELECT * FROM tutor_jobs WHERE id = ?").get(id) as TutorJob | undefined;
}

/** Create a job unless one with the same job_key already exists. Returns the job id. */
export function createJob(
	db: DatabaseSync,
	params: { purpose: string; jobKey: string; snapshotHash: string; pipelineVersion: number; phase: JobPhase; now: Date },
): string {
	const existing = findJobByKey(db, params.jobKey);
	if (existing) return existing.id;
	const id = randomUUID();
	const now = params.now.toISOString();
	db.prepare(
		`INSERT INTO tutor_jobs
		 (id, purpose, job_key, snapshot_hash, pipeline_version, phase, status, version, attempt_count, next_run_at, artifacts_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, '{}', ?, ?)`,
	).run(id, params.purpose, params.jobKey, params.snapshotHash, params.pipelineVersion, params.phase, now, now, now);
	return id;
}

/** Claim a runnable job with an exclusive lease. Returns true iff this caller won. */
export function claimJob(
	db: DatabaseSync,
	id: string,
	owner: string,
	leaseToken: string,
	leaseUntil: Date,
	now: Date,
): boolean {
	const res = db.prepare(
		`UPDATE tutor_jobs
		 SET owner = ?, lease_token = ?, lease_until = ?, status = 'running',
		     attempt_count = attempt_count + 1, version = version + 1, updated_at = ?
		 WHERE id = ? AND (
		   status IN ('queued','deferred')
		   OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?)
		 )`,
	).run(owner, leaseToken, leaseUntil.toISOString(), now.toISOString(), id, now.toISOString());
	return res.changes === 1;
}

/** Advance the phase and clear the lease. CAS on (id, version, lease_token). */
export function finalizePhase(
	db: DatabaseSync,
	id: string,
	expectedVersion: number,
	leaseToken: string,
	next: { phase: JobPhase; status: JobStatus; artifactsJson: string; failureJson: string | null; nextRunAt: string },
	now: Date,
): boolean {
	const res = db.prepare(
		`UPDATE tutor_jobs
		 SET phase = ?, status = ?, artifacts_json = ?, failure_json = ?, next_run_at = ?,
		     lease_token = NULL, lease_until = NULL, owner = NULL, version = version + 1, updated_at = ?
		 WHERE id = ? AND version = ? AND lease_token = ?`,
	).run(next.phase, next.status, next.artifactsJson, next.failureJson, next.nextRunAt, now.toISOString(), id, expectedVersion, leaseToken);
	return res.changes === 1;
}

/** Idempotently record a parallel phase artifact (candidate/critic output). Does not touch the parent version. */
export function writeArtifact(
	db: DatabaseSync,
	jobId: string,
	jobVersion: number,
	phase: JobPhase,
	key: string,
	inputHash: string | null,
	payloadJson: string,
	now: Date,
): boolean {
	const res = db.prepare(
		`INSERT OR IGNORE INTO tutor_job_artifacts
		 (job_id, job_version, phase, artifact_key, input_hash, status, payload_json, created_at)
		 VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
	).run(jobId, jobVersion, phase, key, inputHash, payloadJson, now.toISOString());
	return res.changes === 1;
}

/** Release expired leases so a new coordinator can resume those jobs. Returns the count reaped. */
export function reapExpiredJobs(db: DatabaseSync, now: Date): number {
	const res = db.prepare(
		`UPDATE tutor_jobs
		 SET status = 'queued', lease_token = NULL, lease_until = NULL, owner = NULL, version = version + 1, updated_at = ?
		 WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
	).run(now.toISOString(), now.toISOString());
	return Number(res.changes);
}
