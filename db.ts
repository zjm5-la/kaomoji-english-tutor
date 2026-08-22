import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { restoreCard } from "./fsrs.ts";
import type { GeneratedItem } from "./llm.ts";

// -- SQLite storage -------------------------------------------------------

export interface ItemRow {
	id: number;
	type: "word" | "phrase" | "sentence" | "cloze";
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
	// Adaptive columns (inert in protocol 1; written by later milestones)
	lesson_id?: number | null;
	lexical_sense_id?: number | null;
	role?: string | null;
	content_fingerprint?: string | null;
	content_version?: number;
	introduced_at?: string | null;
	introduction_kind?: string | null;
	introduction_accuracy?: string;
	content_status?: string;
	legacy_duplicate_of?: number | null;
	fsrs_status?: string;
	fsrs_error?: string | null;
	fsrs_corrupt_at?: string | null;
}

/** Add a column only when missing; replaces the old try/catch ALTER pattern. */
function addColumnIfMissing(
	db: DatabaseSync,
	table: string,
	columnDef: string,
): void {
	const name = columnDef.trim().split(/\s+/)[0];
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
		name: string;
	}[];
	if (!cols.some((c) => c.name === name)) {
		// pi-lens-ignore: sql-injection
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
	}
}

/** Record this client's protocol version + heartbeat (protocol 1). */
export function touchClient(db: DatabaseSync, clientId: string): void {
	db.prepare(
		"INSERT INTO runtime_clients (client_id, protocol_version, last_seen) VALUES (?, 1, ?) ON CONFLICT(client_id) DO UPDATE SET last_seen = excluded.last_seen, protocol_version = excluded.protocol_version",
	).run(clientId, new Date().toISOString());
}

/**
 * Versioned, idempotent schema migrations. Each step runs inside its own short
 * transaction and is recorded in `schema_migrations`, so completion no longer
 * depends on swallowing ALTER errors.
 */
const SCHEMA_TARGET_VERSION = 12;
const SCHEMA_MIGRATIONS: ((db: DatabaseSync) => void)[] = [
	// v1: adaptive tutor compatibility schema (protocol 1).
	// All structures are empty and unused at runtime; existing behavior is unchanged.
	(db: DatabaseSync) => {
		// Legacy column upgrades (previously guarded by try/catch ALTER).
		for (const col of [
			"status TEXT NOT NULL DEFAULT 'learning'",
			"levels TEXT",
			"levels_cn TEXT",
			"chunks TEXT",
			"key_words TEXT",
			"progress INTEGER NOT NULL DEFAULT 0",
		])
			addColumnIfMissing(db, "items", col);
		for (const col of ["generation_token TEXT", "generation_until TEXT"]) {
			addColumnIfMissing(db, "runtime_state", col);
		}

		// Adaptive items columns (written by later milestones; inert in protocol 1).
		for (const col of [
			"lesson_id INTEGER",
			"lexical_sense_id INTEGER",
			"role TEXT",
			"content_fingerprint TEXT",
			"content_version INTEGER NOT NULL DEFAULT 1",
			"introduced_at TEXT",
			"introduction_kind TEXT",
			"introduction_accuracy TEXT NOT NULL DEFAULT 'exact'",
			"content_status TEXT NOT NULL DEFAULT 'approved'",
			"legacy_duplicate_of INTEGER",
			"fsrs_status TEXT NOT NULL DEFAULT 'ok'",
			"fsrs_error TEXT",
			"fsrs_corrupt_at TEXT",
		])
			addColumnIfMissing(db, "items", col);

		db.exec(`
			CREATE TABLE IF NOT EXISTS lessons (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				mode TEXT NOT NULL, topic TEXT, objective TEXT NOT NULL,
				context_hash TEXT NOT NULL, snapshot_version INTEGER NOT NULL,
				plan_json TEXT NOT NULL, quality_json TEXT NOT NULL,
				status TEXT NOT NULL, created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS lexical_senses (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL CHECK (kind IN ('word','phrase')),
				surface TEXT NOT NULL, normalized_surface TEXT NOT NULL,
				part_of_speech TEXT, meaning_zh TEXT NOT NULL,
				normalized_meaning TEXT NOT NULL, usage_note TEXT,
				sense_fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS lexical_senses_surface_idx
				on lexical_senses(kind, normalized_surface);
			CREATE TABLE IF NOT EXISTS lexical_surface_versions (
				kind TEXT NOT NULL, normalized_surface TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (kind, normalized_surface)
			);
			CREATE TABLE IF NOT EXISTS supporting_materials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				lesson_id INTEGER NOT NULL, kind TEXT NOT NULL,
				content_json TEXT NOT NULL,
				content_fingerprint TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS exercises (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				item_id INTEGER NOT NULL, kind TEXT NOT NULL,
				schema_version INTEGER NOT NULL, stage TEXT NOT NULL,
				content_fingerprint TEXT NOT NULL UNIQUE,
				prompt_json TEXT NOT NULL, answer_json TEXT NOT NULL,
				hints_json TEXT NOT NULL, rubric_json TEXT NOT NULL,
				quality_json TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'approved',
				used_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS exercise_senses (
				exercise_id INTEGER NOT NULL, lexical_sense_id INTEGER NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('target','contrast','accepted_alternative')),
				PRIMARY KEY (exercise_id, lexical_sense_id, role)
			);
			CREATE TABLE IF NOT EXISTS content_catalog_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL DEFAULT 0
			);
			INSERT OR IGNORE INTO content_catalog_state (id, version) VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY, item_id INTEGER NOT NULL, exercise_id INTEGER,
				review_cycle_id TEXT NOT NULL, claim_key TEXT NOT NULL UNIQUE,
				question_version INTEGER NOT NULL, evaluation_version INTEGER NOT NULL,
				kind TEXT NOT NULL, answer_text TEXT, assistance_level TEXT NOT NULL,
				direction TEXT CHECK (direction IN ('forward','reverse')),
				question_text TEXT,
				status TEXT NOT NULL CHECK (status IN ('evaluating','evaluated','superseded','stale','abandoned','self_report')),
				evaluation_owner TEXT, evaluation_token TEXT, evaluation_until TEXT,
				verdict TEXT, error_tags_json TEXT, feedback_json TEXT,
				explicit_rating TEXT, started_at TEXT NOT NULL,
				completed_at TEXT, rated_at TEXT
			);
			CREATE TABLE IF NOT EXISTS mastery_state (
				item_id INTEGER PRIMARY KEY, stage TEXT NOT NULL,
				recognition_evidence INTEGER NOT NULL DEFAULT 0,
				recall_evidence INTEGER NOT NULL DEFAULT 0,
				use_evidence INTEGER NOT NULL DEFAULT 0,
				transfer_evidence INTEGER NOT NULL DEFAULT 0,
				unassisted_good INTEGER NOT NULL DEFAULT 0,
				assisted_good INTEGER NOT NULL DEFAULT 0,
				consecutive_again INTEGER NOT NULL DEFAULT 0,
				contrast_pending INTEGER NOT NULL DEFAULT 0,
				last_evidence_cycle_id TEXT,
				error_profile_json TEXT NOT NULL DEFAULT '{}',
				last_exercise_kind TEXT, updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS content_reports (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				item_id INTEGER, exercise_id INTEGER, reason TEXT NOT NULL,
				content_version INTEGER NOT NULL, status TEXT NOT NULL,
				review_job_id TEXT, resolution_json TEXT, created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS fsrs_corruptions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				item_id INTEGER NOT NULL, raw_fsrs_state TEXT, error_code TEXT,
				detected_at TEXT NOT NULL, resolution TEXT
			);
			-- Compatibility-only protocol-1 tables. The unshipped job runtime was removed;
			-- keep these tables so existing databases remain forward-compatible.
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
			CREATE TABLE IF NOT EXISTS replacement_requests (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_item_id INTEGER, source_snapshot_json TEXT,
				requested_type TEXT NOT NULL, status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
				last_context_hash TEXT, created_at TEXT NOT NULL, completed_at TEXT
			);
			CREATE TABLE IF NOT EXISTS runtime_clients (
				client_id TEXT PRIMARY KEY,
				protocol_version INTEGER NOT NULL,
				last_seen TEXT NOT NULL
			);
		`);
	},
	// v2: backfill introduced_at for items shown before quota tracking (protocol 1 baseline).
	(db: DatabaseSync) => {
		db.exec(
			"UPDATE items SET introduced_at = learned_at, introduction_kind = 'legacy', introduction_accuracy = 'approximate' " +
				"WHERE shown = 1 AND introduced_at IS NULL",
		);
	},
	// v3: content fingerprint dedup — backfill canonical items and add a unique partial index.
	(db: DatabaseSync) => {
		const rows = db
			.prepare(
				"SELECT id, type, text, meaning FROM items WHERE content_fingerprint IS NULL ORDER BY id ASC",
			)
			.all() as { id: number; type: string; text: string; meaning: string }[];
		const seen = new Map<string, number>();
		const setFp = db.prepare(
			"UPDATE items SET content_fingerprint = ? WHERE id = ?",
		);
		const markDup = db.prepare(
			"UPDATE items SET content_fingerprint = NULL, legacy_duplicate_of = ? WHERE id = ?",
		);
		for (const r of rows) {
			const fp = contentFingerprint(r.type, r.text, r.meaning);
			const canonical = seen.get(fp);
			if (canonical != null) {
				markDup.run(canonical, r.id);
			} else {
				seen.set(fp, r.id);
				setFp.run(fp, r.id);
			}
		}
		db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS items_content_fingerprint_uq ON items(content_fingerprint) WHERE content_fingerprint IS NOT NULL",
		);
	},
	// v4: persist the active recall direction with the global card slot.
	(db: DatabaseSync) => {
		addColumnIfMissing(
			db,
			"runtime_state",
			"active_direction TEXT NOT NULL DEFAULT 'forward'",
		);
	},
	// v5: persist progressive sentence-output cycles across sessions/reloads.
	(db: DatabaseSync) => {
		for (const col of [
			"active_review_cycle_id TEXT",
			"active_exercise_id INTEGER",
			"active_cycle_outcome TEXT",
			"active_retry_count INTEGER NOT NULL DEFAULT 0",
			"active_assistance_level TEXT NOT NULL DEFAULT 'none'",
		])
			addColumnIfMissing(db, "runtime_state", col);
	},
	// v6: indexes for the now-shared scheduling and first-display predicates.
	(db: DatabaseSync) => {
		db.exec(
			"CREATE INDEX IF NOT EXISTS items_due_shown_idx ON items(due_at, shown, id) WHERE content_status = 'approved'",
		);
		db.exec(
			"CREATE INDEX IF NOT EXISTS items_introduction_idx ON items(introduction_kind, introduced_at) WHERE introduction_kind = 'planned'",
		);
	},
	// v7: restore states falsely quarantined because fsrs.js emits fractional elapsed_days.
	(db: DatabaseSync) => {
		const rows = db
			.prepare(
				"SELECT c.id AS corruption_id, c.item_id, c.raw_fsrs_state FROM fsrs_corruptions c JOIN items i ON i.id = c.item_id WHERE c.resolution IS NULL AND c.error_code = 'invalid_field:elapsed_days' AND i.fsrs_status = 'corrupt' AND i.fsrs_state = c.raw_fsrs_state",
			)
			.all() as {
			corruption_id: number;
			item_id: number;
			raw_fsrs_state: string;
		}[];
		for (const row of rows) {
			if ("corrupt" in restoreCard(row.raw_fsrs_state)) continue;
			const restored = db
				.prepare(
					"UPDATE items SET fsrs_status = 'ok', fsrs_error = NULL, fsrs_corrupt_at = NULL WHERE id = ? AND fsrs_status = 'corrupt' AND fsrs_state = ?",
				)
				.run(row.item_id, row.raw_fsrs_state);
			if (Number(restored.changes) > 0) {
				db.prepare(
					"UPDATE fsrs_corruptions SET resolution = 'restored:v7_fractional_elapsed_days_false_positive' WHERE id = ?",
				).run(row.corruption_id);
			}
		}
	},
	// v8: persist the recall direction with each attempt (learner-profile signal).
	(db: DatabaseSync) => {
		addColumnIfMissing(
			db,
			"attempts",
			"direction TEXT CHECK (direction IN ('forward','reverse'))",
		);
	},
	// v9: persist the presented question text with each attempt (audit + lesson-prep evidence).
	(db: DatabaseSync) => {
		addColumnIfMissing(db, "attempts", "question_text TEXT");
	},
	// v10: per-direction FSRS state for word/phrase recall (recognition and
	// production are different skills and must not share one schedule).
	(db: DatabaseSync) => {
		migrateDirectionState(db);
	},
	// v11: cloze grammar-fill cards. Existing sentence cards keep working; the
	// generator's third slot becomes cloze instead of progressive sentences.
	(db: DatabaseSync) => {
		rebuildItemsTableForCloze(db);
	},
	// v12: staging queue for /anki:add custom cards. Cards are made immediately
	// but released into items day by day, consuming the daily new-card quota.
	(db: DatabaseSync) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS custom_card_queue (
				id INTEGER PRIMARY KEY,
				created_at TEXT NOT NULL,
				prompt TEXT NOT NULL,
				fingerprint TEXT NOT NULL,
				payload TEXT NOT NULL
			);
		`);
	},
];

/** Recreate items with a CHECK that also admits 'cloze' (SQLite cannot ALTER a CHECK). */
function rebuildItemsTableForCloze(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE items_v11 (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL CHECK (type IN ('word', 'phrase', 'sentence', 'cloze')),
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
			progress INTEGER NOT NULL DEFAULT 0,
			lesson_id INTEGER,
			lexical_sense_id INTEGER,
			role TEXT,
			content_fingerprint TEXT,
			content_version INTEGER NOT NULL DEFAULT 1,
			introduced_at TEXT,
			introduction_kind TEXT,
			introduction_accuracy TEXT NOT NULL DEFAULT 'exact',
			content_status TEXT NOT NULL DEFAULT 'approved',
			legacy_duplicate_of INTEGER,
			fsrs_status TEXT NOT NULL DEFAULT 'ok',
			fsrs_error TEXT,
			fsrs_corrupt_at TEXT
		);
		INSERT INTO items_v11 (
			id, type, text, phonetic, meaning, example, example_cn, learned_at, fsrs_state, due_at,
			shown, reviews, status, levels, levels_cn, chunks, key_words, progress, lesson_id, lexical_sense_id,
			role, content_fingerprint, content_version, introduced_at, introduction_kind, introduction_accuracy,
			content_status, legacy_duplicate_of, fsrs_status, fsrs_error, fsrs_corrupt_at
		)
		SELECT
			id, type, text, phonetic, meaning, example, example_cn, learned_at, fsrs_state, due_at,
			shown, reviews, status, levels, levels_cn, chunks, key_words, progress, lesson_id, lexical_sense_id,
			role, content_fingerprint, content_version, introduced_at, introduction_kind, introduction_accuracy,
			content_status, legacy_duplicate_of, fsrs_status, fsrs_error, fsrs_corrupt_at
		FROM items;
		DROP TABLE items;
		ALTER TABLE items_v11 RENAME TO items;
		CREATE UNIQUE INDEX IF NOT EXISTS items_content_fingerprint_uq ON items(content_fingerprint) WHERE content_fingerprint IS NOT NULL;
		CREATE INDEX IF NOT EXISTS items_due_shown_idx ON items(due_at, shown, id) WHERE content_status = 'approved';
		CREATE INDEX IF NOT EXISTS items_introduction_idx ON items(introduction_kind, introduced_at) WHERE introduction_kind = 'planned';
	`);
}

/**
 * Create direction_state and backfill both directions from the legacy single
 * FSRS state for already-rated word/phrase items. Idempotent (INSERT OR IGNORE),
 * safe to re-run; sentences stay on the legacy single state.
 */
export function migrateDirectionState(db: DatabaseSync): void {
	const ts = new Date().toISOString();
	db.exec(`
		CREATE TABLE IF NOT EXISTS direction_state (
			item_id INTEGER NOT NULL,
			direction TEXT NOT NULL CHECK (direction IN ('forward','reverse')),
			fsrs_state TEXT NOT NULL DEFAULT '',
			due_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (item_id, direction)
		);
	`);
	for (const dir of ["forward", "reverse"]) {
		db.prepare(
			`INSERT OR IGNORE INTO direction_state (item_id, direction, fsrs_state, due_at, updated_at)
			 SELECT id, ?, fsrs_state, due_at, ? FROM items
			 WHERE type IN ('word','phrase') AND fsrs_state <> ''`,
		).run(dir, ts);
	}
}

function runMigrations(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_meta (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			schema_version INTEGER NOT NULL DEFAULT 0,
			adaptive_protocol INTEGER NOT NULL DEFAULT 0,
			migration_state TEXT NOT NULL DEFAULT 'pending'
		);
		INSERT OR IGNORE INTO schema_meta (id, schema_version, adaptive_protocol, migration_state)
		VALUES (1, 0, 0, 'pending');
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
		);
	`);
	const applied = new Set(
		(
			db.prepare("SELECT version FROM schema_migrations").all() as {
				version: number;
			}[]
		).map((r) => r.version),
	);
	for (let v = 1; v <= SCHEMA_TARGET_VERSION; v++) {
		if (applied.has(v)) continue;
		const step = SCHEMA_MIGRATIONS[v - 1];
		if (!step) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			// Another process may have committed this migration while BEGIN waited.
			if (
				db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(v)
			) {
				db.exec("COMMIT");
				continue;
			}
			step(db);
			db.prepare(
				"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
			).run(v, new Date().toISOString());
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* no transaction */
			}
			throw err;
		}
	}
	db.prepare(
		"UPDATE schema_meta SET schema_version = ?, adaptive_protocol = 1, migration_state = 'complete' WHERE id = 1",
	).run(SCHEMA_TARGET_VERSION);
}

export function openDb(): DatabaseSync {
	const db = new DatabaseSync(join(getAgentDir(), "kaomoji-english-tutor.db"));
	db.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL CHECK (type IN ('word', 'phrase', 'sentence', 'cloze')),
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
			active_direction TEXT NOT NULL DEFAULT 'forward',
			active_version INTEGER NOT NULL DEFAULT 0,
			active_review_cycle_id TEXT,
			active_exercise_id INTEGER,
			active_cycle_outcome TEXT,
			active_retry_count INTEGER NOT NULL DEFAULT 0,
			active_assistance_level TEXT NOT NULL DEFAULT 'none',
			next_check_at TEXT NOT NULL,
			coordinator TEXT,
			coordinator_until TEXT,
			generation_token TEXT,
			generation_until TEXT,
			last_activity TEXT
		);
		INSERT OR IGNORE INTO runtime_state (id, active_version, next_check_at) VALUES (1, 0, '');
	`);
	runMigrations(db);
	return db;
}

export function getStat(db: DatabaseSync, key: string): string | null {
	const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(key) as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

export function setStat(db: DatabaseSync, key: string, value: string | number) {
	db.prepare(
		"INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, String(value));
}

export function bumpStat(db: DatabaseSync, key: string, delta: number) {
	setStat(db, key, Number(getStat(db, key) ?? 0) + delta);
}

export interface GenLogEntry {
	t: string;
	s: string;
}

const GEN_LOG_KEY = "gen_log";
const GEN_LOG_CAP = 20;

export function getGenLog(db: DatabaseSync): GenLogEntry[] {
	const raw = getStat(db, GEN_LOG_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is GenLogEntry =>
				Boolean(e) && typeof e.t === "string" && typeof e.s === "string",
		);
	} catch {
		return [];
	}
}

/** Append a lesson/replacement generation decision to the bounded ring log (newest last). */
export function appendGenLog(db: DatabaseSync, status: string): void {
	const entries = getGenLog(db);
	entries.push({ t: new Date().toISOString(), s: status.slice(0, 200) });
	setStat(db, GEN_LOG_KEY, JSON.stringify(entries.slice(-GEN_LOG_CAP)));
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
export function touchStreak(db: DatabaseSync, now: Date) {
	const today = localDateStr(now);
	const last = getStat(db, "last_active_date");
	if (last === today) return;
	const yesterday = localDateStr(new Date(now.getTime() - 24 * 3600 * 1000));
	const days =
		last === yesterday ? Number(getStat(db, "streak_days") ?? 0) + 1 : 1;
	setStat(db, "streak_days", days);
	setStat(db, "last_active_date", today);
}

/** Mastery stage progression + demotion (deterministic, §6.2). */
const MASTERY_STAGES = [
	"exposure",
	"recognition",
	"controlled_recall",
	"production",
	"transfer",
] as const;
const MASTERY_PROMOTE_THRESHOLDS = [1, 2, 2, 2]; // unassisted Good count needed to leave each stage
export function computeMasteryStage(
	prevStage: string,
	unassistedGood: number,
	isAgain: boolean,
): string {
	const idx = Math.max(0, MASTERY_STAGES.indexOf(prevStage as never));
	if (isAgain) return MASTERY_STAGES[Math.max(0, idx - 1)];
	// Promote at most one stage per rating: reaching the threshold advances a single level.
	if (
		idx < MASTERY_STAGES.length - 1 &&
		unassistedGood >= MASTERY_PROMOTE_THRESHOLDS[idx]
	) {
		return MASTERY_STAGES[idx + 1];
	}
	return MASTERY_STAGES[idx];
}

/** Deterministic content fingerprint for exact dedup: type + normalized text + normalized meaning. */
export function contentFingerprint(
	type: string,
	text: string,
	meaning: string,
): string {
	const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
	return createHash("sha256")
		.update(`${type}\u0000${norm(text)}\u0000${norm(meaning)}`, "utf8")
		.digest("hex");
}

/** Sense fingerprint: kind + normalized surface + part of speech + normalized meaning. */
function senseFingerprint(
	kind: "word" | "phrase",
	surface: string,
	pos: string | null,
	meaning: string,
): string {
	const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
	return createHash("sha256")
		.update(
			`${kind}\u0000${norm(surface)}\u0000${pos ?? ""}\u0000${norm(meaning)}`,
			"utf8",
		)
		.digest("hex");
}

/** Find or create a lexical_sense for a word/phrase item; sentences have no sense. */
function ensureLexicalSense(
	db: DatabaseSync,
	type: string,
	text: string,
	meaning: string,
	now: Date,
): number | null {
	if (type !== "word" && type !== "phrase") return null;
	const kind = type as "word" | "phrase";
	const fp = senseFingerprint(kind, text, null, meaning);
	const existing = db
		.prepare("SELECT id FROM lexical_senses WHERE sense_fingerprint = ?")
		.get(fp) as { id: number } | undefined;
	if (existing) return existing.id;
	const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
	const result = db
		.prepare(
			"INSERT INTO lexical_senses (kind, surface, normalized_surface, part_of_speech, meaning_zh, normalized_meaning, sense_fingerprint, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
		)
		.run(kind, text, norm(text), meaning, norm(meaning), fp, now.toISOString());
	return Number(result.lastInsertRowid);
}

export function getDueItem(db: DatabaseSync, now: Date): ItemRow | undefined {
	return db
		.prepare(
			`SELECT * FROM items WHERE due_at <= ? ${SCHEDULABLE} ORDER BY due_at ASC, id ASC LIMIT 1`,
		)
		.get(now.toISOString()) as ItemRow | undefined;
}

/** Shared predicate for items eligible to be surfaced by the scheduler.
 * Excludes corrupt, quarantined, or legacy-duplicate content. */
export const SCHEDULABLE =
	"AND (fsrs_status = 'ok' OR fsrs_status IS NULL) AND content_status = 'approved' AND legacy_duplicate_of IS NULL";

export function insertItem(
	db: DatabaseSync,
	type: string,
	text: string,
	phonetic: string | null,
	meaning: string,
	example: string | null,
	example_cn: string | null,
	now: Date,
	extra?: {
		levels?: string[];
		levels_cn?: string[];
		chunks?: string[];
		keyWords?: GeneratedItem["keyWords"];
		introductionKind?: "planned" | "replacement" | "custom";
	},
): number {
	const senseId = ensureLexicalSense(db, type, text, meaning, now);
	const ts = now.toISOString();
	const introductionKind = extra?.introductionKind ?? "planned";
	const result = db
		.prepare(
			"INSERT INTO items (type, text, phonetic, meaning, example, example_cn, learned_at, due_at, levels, levels_cn, chunks, key_words, content_fingerprint, lexical_sense_id, introduction_kind, introduced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
		)
		.run(
			type,
			text,
			phonetic,
			meaning,
			example,
			example_cn,
			ts,
			ts,
			extra?.levels ? JSON.stringify(extra.levels) : null,
			extra?.levels_cn ? JSON.stringify(extra.levels_cn) : null,
			extra?.chunks ? JSON.stringify(extra.chunks) : null,
			extra?.keyWords ? JSON.stringify(extra.keyWords) : null,
			contentFingerprint(type, text, meaning),
			senseId,
			introductionKind,
		);
	return Number(result.lastInsertRowid);
}

export function markShown(db: DatabaseSync, id: number) {
	db.prepare("UPDATE items SET shown = 1 WHERE id = ?").run(id);
}

export function advanceReview(
	db: DatabaseSync,
	id: number,
	fsrsState: string,
	dueAt: string,
	reviews: number,
) {
	db.prepare(
		"UPDATE items SET fsrs_state = ?, due_at = ?, reviews = ? WHERE id = ?",
	).run(fsrsState, dueAt, reviews, id);
}

/**
 * Pick which recall direction a word/phrase review should use: the due
 * direction with the earliest due_at; ties and all fallbacks prefer forward
 * (production first, so a recognition exposure cannot prime a same-day
 * production answer).
 */
export function dueDirection(db: DatabaseSync, itemId: number, now: Date): "forward" | "reverse" {
	const rows = db
		.prepare("SELECT direction, due_at FROM direction_state WHERE item_id = ?")
		.all(itemId) as { direction: "forward" | "reverse"; due_at: string }[];
	if (rows.length === 0) return "forward";
	const iso = now.toISOString();
	const due = rows.filter((r) => r.due_at <= iso);
	const candidates = due.length > 0 ? due : rows;
	candidates.sort(
		(a, b) => a.due_at.localeCompare(b.due_at) || (a.direction === "forward" ? -1 : 1),
	);
	return candidates[0].direction;
}

/** Read one direction's stored FSRS blob; null when no row exists yet. */
export function directionFsrsState(db: DatabaseSync, itemId: number, direction: "forward" | "reverse"): string | null {
	const row = db
		.prepare("SELECT fsrs_state FROM direction_state WHERE item_id = ? AND direction = ?")
		.get(itemId, direction) as { fsrs_state: string } | undefined;
	return row?.fsrs_state ?? null;
}

/**
 * Advance one direction of a word/phrase item. The untested sibling direction
 * is created fresh, first surfacing alongside the rated direction's new due.
 * items.fsrs_state mirrors the forward (production) state and items.due_at is
 * the minimum over both directions, so legacy readers stay consistent.
 */
/**
 * Minimum spacing between the two recall directions of one item: rating one
 * direction pushes the other at least this far out, so recognition can never
 * prime a same-day production answer (and vice versa).
 */
export const DIRECTION_MIN_SEPARATION_MS = 24 * 3600 * 1000;

export function advanceReviewDirectional(
	db: DatabaseSync,
	id: number,
	direction: "forward" | "reverse",
	fsrsState: string,
	dueAt: string,
	reviews: number,
	now: Date,
) {
	const ts = now.toISOString();
	const sibling = direction === "forward" ? "reverse" : "forward";
	const siblingMinDue = new Date(now.getTime() + DIRECTION_MIN_SEPARATION_MS).toISOString();
	db.prepare(
		"INSERT OR IGNORE INTO direction_state (item_id, direction, fsrs_state, due_at, updated_at) VALUES (?, ?, '', ?, ?)",
	).run(id, sibling, siblingMinDue, ts);
	// An already-scheduled sibling keeps its FSRS plan but cannot surface within 24h.
	db.prepare(
		"UPDATE direction_state SET due_at = MAX(due_at, ?), updated_at = ? WHERE item_id = ? AND direction = ?",
	).run(siblingMinDue, ts, id, sibling);
	db.prepare(
		`INSERT INTO direction_state (item_id, direction, fsrs_state, due_at, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(item_id, direction) DO UPDATE SET fsrs_state = excluded.fsrs_state, due_at = excluded.due_at, updated_at = excluded.updated_at`,
	).run(id, direction, fsrsState, dueAt, ts);
	const fwd = db
		.prepare("SELECT fsrs_state FROM direction_state WHERE item_id = ? AND direction = 'forward'")
		.get(id) as { fsrs_state: string } | undefined;
	const minDue = db
		.prepare("SELECT MIN(due_at) AS d FROM direction_state WHERE item_id = ?")
		.get(id) as { d: string };
	db.prepare(
		"UPDATE items SET fsrs_state = ?, due_at = ?, reviews = ? WHERE id = ?",
	).run(fwd?.fsrs_state ?? "", minDue.d, reviews, id);
}

export function countTodayNew(db: DatabaseSync, now: Date): number {
	const row = db
		.prepare(
			"SELECT COUNT(*) AS n FROM items WHERE introduction_kind IN ('planned', 'custom') AND introduced_at >= ?",
		)
		.get(localDayStartISO(now)) as { n: number };
	return Number(row.n);
}

export function knownList(db: DatabaseSync): string[] {
	const rows = db
		.prepare("SELECT text FROM items WHERE shown = 1 ORDER BY id DESC LIMIT 30")
		.all() as {
		text: string;
	}[];
	return rows.map((r) => r.text);
}

export function replacementKnownList(db: DatabaseSync): string[] {
	const rows = db
		.prepare("SELECT type, text, meaning FROM items ORDER BY id DESC LIMIT 50")
		.all() as Array<{
		type: string;
		text: string;
		meaning: string;
	}>;
	return rows.map((row) => `${row.type}: ${row.text} = ${row.meaning}`);
}

export function pendingReplacementTypes(
	db: DatabaseSync,
): GeneratedItem["type"][] {
	const raw = getStat(db, "pending_replacements");
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(type): type is GeneratedItem["type"] =>
				type === "word" || type === "phrase" || type === "sentence" || type === "cloze",
		);
	} catch {
		return [];
	}
}

export function enqueueReplacement(
	db: DatabaseSync,
	type: GeneratedItem["type"],
) {
	setStat(
		db,
		"pending_replacements",
		JSON.stringify([...pendingReplacementTypes(db), type]),
	);
}

export function consumeReplacement(
	db: DatabaseSync,
	type: GeneratedItem["type"],
): boolean {
	const queue = pendingReplacementTypes(db);
	if (queue[0] !== type) return false;
	queue.shift();
	setStat(db, "pending_replacements", JSON.stringify(queue));
	return true;
}

// -- /anki:add custom-card queue --------------------------------------------

export interface CustomQueueRow {
	id: number;
	created_at: string;
	prompt: string;
	fingerprint: string;
	payload: string;
}

/** Stage a finished custom card; FIFO order follows insertion (rowid) order. */
export function enqueueCustomCard(
	db: DatabaseSync,
	prompt: string,
	item: GeneratedItem,
): void {
	db.prepare(
			"INSERT INTO custom_card_queue (created_at, prompt, fingerprint, payload) VALUES (?, ?, ?, ?)",
	).run(
		new Date().toISOString(),
		prompt,
		contentFingerprint(item.type, item.text, item.meaning),
		JSON.stringify(item),
	);
}

/** Oldest-first queue rows (FIFO). */
export function peekCustomQueue(db: DatabaseSync, limit: number): CustomQueueRow[] {
	return db
		.prepare("SELECT * FROM custom_card_queue ORDER BY id ASC LIMIT ?")
		.all(limit) as CustomQueueRow[];
}

export function listCustomQueue(db: DatabaseSync): CustomQueueRow[] {
	return db
		.prepare("SELECT * FROM custom_card_queue ORDER BY id ASC")
		.all() as CustomQueueRow[];
}

export function removeCustomQueueRows(db: DatabaseSync, ids: number[]): void {
	if (!ids.length) return;
	const del = db.prepare("DELETE FROM custom_card_queue WHERE id = ?");
	for (const id of ids) del.run(id);
}

export function customQueueCount(db: DatabaseSync): number {
	const row = db.prepare("SELECT COUNT(*) AS n FROM custom_card_queue").get() as { n: number };
	return Number(row.n);
}
