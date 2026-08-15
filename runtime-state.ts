import type { DatabaseSync } from "node:sqlite";
import type { ItemRow } from "./db.ts";
import type { GeneratedItem } from "./llm.ts";

// -- Multi-session runtime state ------------------------------------------

export type RecallDirection = "forward" | "reverse";
export type AssistanceLevel = "none" | "hint" | "revealed";

export interface PendingAttempt {
	itemId: number;
	version: number;
	direction: RecallDirection;
	sessionGeneration: number;
	answerText: string;
	assistanceLevel: AssistanceLevel;
	startedAt: string;
	verdict: "correct" | "partial" | "incorrect";
	feedback: string;
	reviewCycleId?: string;
	exerciseId?: number;
	kind?: string;
	errorTags?: string[];
	correctedAnswer?: string;
	questionText?: string;
}

export interface RuntimeState {
	active_item_id: number | null;
	active_kind: "review" | "teach" | null;
	active_direction: RecallDirection;
	active_version: number;
	active_review_cycle_id: string | null;
	active_exercise_id: number | null;
	active_cycle_outcome: "clean" | "again" | null;
	active_retry_count: number;
	active_assistance_level: AssistanceLevel;
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
		active_direction: "forward",
		active_version: 0,
		active_review_cycle_id: null,
		active_exercise_id: null,
		active_cycle_outcome: null,
		active_retry_count: 0,
		active_assistance_level: "none",
		next_check_at: new Date(0).toISOString(),
		coordinator: null,
		coordinator_until: null,
		generation_token: null,
		generation_until: null,
		last_activity: null,
	};
}

export function getRuntimeState(db: DatabaseSync): RuntimeState {
	let row = db.prepare("SELECT * FROM runtime_state WHERE id = 1").get() as RuntimeState | undefined;
	if (!row) {
		db.prepare("INSERT OR IGNORE INTO runtime_state (id, active_version, next_check_at) VALUES (1, 0, '')").run();
		row = db.prepare("SELECT * FROM runtime_state WHERE id = 1").get() as RuntimeState | undefined;
	}
	if (!row) return defaultRuntimeState();
	return {
		active_item_id: row.active_item_id,
		active_kind: row.active_kind as RuntimeState["active_kind"],
		active_direction: row.active_direction === "reverse" ? "reverse" : "forward",
		active_version: Number(row.active_version ?? 0),
		active_review_cycle_id: row.active_review_cycle_id,
		active_exercise_id: row.active_exercise_id == null ? null : Number(row.active_exercise_id),
		active_cycle_outcome: row.active_cycle_outcome === "again" ? "again" : row.active_cycle_outcome === "clean" ? "clean" : null,
		active_retry_count: Number(row.active_retry_count ?? 0),
		active_assistance_level: row.active_assistance_level === "revealed" ? "revealed" : row.active_assistance_level === "hint" ? "hint" : "none",
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
	"active_direction",
	"active_version",
	"active_review_cycle_id",
	"active_exercise_id",
	"active_cycle_outcome",
	"active_retry_count",
	"active_assistance_level",
	"next_check_at",
	"coordinator",
	"coordinator_until",
	"generation_token",
	"generation_until",
	"last_activity",
]);

/** Update only the supplied columns so unrelated cross-process state cannot be clobbered. */
export function setRuntimeState(db: DatabaseSync, patch: Partial<RuntimeState>) {
	const entries = Object.entries(patch).filter(([key]) => RUNTIME_COLUMNS.has(key as keyof RuntimeState));
	if (!entries.length) return;
	const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
	db.prepare(`UPDATE runtime_state SET ${assignments} WHERE id = 1`).run(...entries.map(([, value]) => value));
}

export const EMPTY_SENTENCE_CYCLE: Pick<RuntimeState,
	"active_review_cycle_id" | "active_exercise_id" | "active_cycle_outcome" | "active_retry_count" | "active_assistance_level"
> = {
	active_review_cycle_id: null,
	active_exercise_id: null,
	active_cycle_outcome: null,
	active_retry_count: 0,
	active_assistance_level: "none",
};

/** True when the global pacing window (next_check_at) has elapsed. */
export function pacingReady(state: RuntimeState, now: Date): boolean {
	if (!state.next_check_at) return true;
	return now.getTime() >= new Date(state.next_check_at).getTime();
}

/** My coordinator identity: `<sessionId>::<instanceToken>`. */
export function myCoordinatorId(sessionId: string, instanceToken: string): string {
	return `${sessionId || "session"}::${instanceToken}`;
}

/** Lower the global pacing window to `now` (used when a card is activated). */
export function resetPacing(db: DatabaseSync) {
	setRuntimeState(db, { next_check_at: new Date().toISOString() });
}

export function activeItem(db: DatabaseSync): ItemRow | undefined {
	const state = getRuntimeState(db);
	if (state.active_item_id == null) return undefined;
	return db.prepare("SELECT * FROM items WHERE id = ?").get(state.active_item_id) as ItemRow | undefined;
}

export function latestMasteredItem(db: DatabaseSync, type: GeneratedItem["type"]): ItemRow | undefined {
	return db
		.prepare("SELECT * FROM items WHERE type = ? AND status = 'mastered' ORDER BY id DESC LIMIT 1")
		.get(type) as ItemRow | undefined;
}
