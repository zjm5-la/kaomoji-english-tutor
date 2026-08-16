// P0-1 direction-independent FSRS scheduling + P0-2 assistance-aware rating policy.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "kaomoji-dir-"));

const { Rating } = await import("fsrs.js");
const { openDb } = await import("../db.ts");
const { effectiveRecallRating, scheduleNext } = await import("../fsrs.ts");

function freshDb() {
	const db = openDb();
	return {
		db,
		close() { db.close(); },
	};
}

// These imports/exports do not exist yet — the tests below define the contract:
// - migrateDirectionState(db): idempotent v10 migration (create + backfill)
// - dueDirection(db, itemId, now): pick the due direction (earliest due; tie -> forward)
// - advanceReviewDirectional(db, id, direction, state, due, reviews, now): upsert one
//   direction, ensure the sibling row exists, mirror items.fsrs_state (forward) and
//   items.due_at (min over directions)
const {
	advanceReviewDirectional,
	dueDirection,
	migrateDirectionState,
} = await import("../db.ts");

const T0 = new Date("2026-08-15T08:00:00.000Z");

function insertRatedWord(db: ReturnType<typeof openDb>, text: string, state: string, due: string): number {
	const r = db
		.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word',?,'释义',?,?,1,?)")
		.run(text, "2026-08-10T08:00:00.000Z", due, state);
	return Number(r.lastInsertRowid);
}

test("v10 migration backfills both directions and is idempotent", () => {
	const h = freshDb();
	try {
		const scheduled = scheduleNext(null, T0, Rating.Good);
		assert.ok(!("corrupt" in scheduled));
		const id = insertRatedWord(h.db, "legacy", scheduled.state, scheduled.due);
		migrateDirectionState(h.db);
		migrateDirectionState(h.db); // re-run: INSERT OR IGNORE keeps it idempotent
		const rows = h.db
			.prepare("SELECT direction, fsrs_state, due_at FROM direction_state WHERE item_id = ? ORDER BY direction")
			.all(id) as { direction: string; fsrs_state: string; due_at: string }[];
		assert.equal(rows.length, 2);
		assert.deepEqual(rows.map((r) => r.direction), ["forward", "reverse"]);
		for (const row of rows) {
			assert.equal(row.fsrs_state, scheduled.state);
			assert.equal(row.due_at, scheduled.due);
		}
		// Sentences stay on the single legacy state: no direction rows.
		const sid = h.db
			.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('sentence','s.','句',?,?,1,?)")
			.run("2026-08-10T08:00:00.000Z", scheduled.due, scheduled.state).lastInsertRowid;
		migrateDirectionState(h.db);
		const srows = h.db.prepare("SELECT COUNT(*) AS n FROM direction_state WHERE item_id = ?").get(Number(sid)) as { n: number };
		assert.equal(srows.n, 0);
	} finally {
		h.close();
	}
});

test("dueDirection picks the due direction; ties and fallbacks prefer forward", () => {
	const h = freshDb();
	try {
		const scheduled = scheduleNext(null, T0, Rating.Good);
		assert.ok(!("corrupt" in scheduled));
		const id = insertRatedWord(h.db, "pick", scheduled.state, scheduled.due);
		const past = "2026-08-14T08:00:00.000Z";
		const future = "2026-08-20T08:00:00.000Z";
		const put = h.db.prepare(
			"INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(item_id,direction) DO UPDATE SET due_at = excluded.due_at",
		);
		const now = T0;
		// No rows at all: production default.
		assert.equal(dueDirection(h.db, id, now), "forward");
		put.run(id, "forward", scheduled.state, future, now.toISOString());
		put.run(id, "reverse", scheduled.state, past, now.toISOString());
		assert.equal(dueDirection(h.db, id, now), "reverse", "only reverse is due");
		put.run(id, "reverse", scheduled.state, future, now.toISOString());
		put.run(id, "forward", scheduled.state, past, now.toISOString());
		assert.equal(dueDirection(h.db, id, now), "forward", "only forward is due");
		// Both due at the same instant: forward first (avoids recognition priming production).
		put.run(id, "reverse", scheduled.state, past, now.toISOString());
		put.run(id, "forward", scheduled.state, past, now.toISOString());
		assert.equal(dueDirection(h.db, id, now), "forward");
		// None due (item surfaced via legacy due_at): earliest due direction wins.
		put.run(id, "reverse", scheduled.state, "2026-08-18T08:00:00.000Z", now.toISOString());
		put.run(id, "forward", scheduled.state, future, now.toISOString());
		assert.equal(dueDirection(h.db, id, now), "reverse");
	} finally {
		h.close();
	}
});

test("advanceReviewDirectional keeps directions independent and mirrors items", () => {
	const h = freshDb();
	try {
		const id = insertRatedWord(h.db, "dual", "", T0.toISOString());
		const good = scheduleNext(null, T0, Rating.Good);
		const again = scheduleNext(null, T0, Rating.Again);
		assert.ok(!("corrupt" in good) && !("corrupt" in again));
		// Rate forward Good: sibling reverse row is created fresh, due alongside.
		advanceReviewDirectional(h.db, id, "forward", good.state, good.due, 1, T0);
		const rows1 = h.db.prepare("SELECT direction, fsrs_state, due_at FROM direction_state WHERE item_id = ? ORDER BY direction").all(id) as { direction: string; fsrs_state: string; due_at: string }[];
		assert.equal(rows1.length, 2);
		assert.equal(rows1[0].fsrs_state, good.state);
		assert.equal(rows1[1].fsrs_state, "", "untested sibling starts empty");
		assert.equal(rows1[1].due_at, good.due, "sibling first surfaces with the rated direction");
		const mirror1 = h.db.prepare("SELECT fsrs_state, due_at, reviews FROM items WHERE id = ?").get(id) as { fsrs_state: string; due_at: string; reviews: number };
		assert.equal(mirror1.fsrs_state, good.state, "items.fsrs_state mirrors forward (production)");
		assert.equal(mirror1.due_at, good.due);
		assert.equal(mirror1.reviews, 1);
		// Rate reverse Again: items.due_at becomes the earlier reverse due; forward untouched.
		advanceReviewDirectional(h.db, id, "reverse", again.state, again.due, 2, T0);
		const fwd = h.db.prepare("SELECT fsrs_state, due_at FROM direction_state WHERE item_id = ? AND direction = 'forward'").get(id) as { fsrs_state: string; due_at: string };
		assert.equal(fwd.fsrs_state, good.state, "recognition failure must not overwrite production state");
		assert.equal(fwd.due_at, good.due);
		const mirror2 = h.db.prepare("SELECT fsrs_state, due_at FROM items WHERE id = ?").get(id) as { fsrs_state: string; due_at: string };
		assert.equal(mirror2.due_at, again.due < good.due ? again.due : good.due, "items.due_at = min over directions");
		assert.equal(mirror2.fsrs_state, good.state);
	} finally {
		h.close();
	}
});

// -- P0-2 assistance-aware rating policy ----------------------------------

test("effectiveRecallRating: unassisted objective correct stays Good", () => {
	assert.equal(effectiveRecallRating({ rating: Rating.Good, assistance: "none", manual: false }), Rating.Good);
	assert.equal(effectiveRecallRating({ rating: Rating.Again, assistance: "none", manual: false }), Rating.Again);
	assert.equal(effectiveRecallRating({ rating: Rating.Again, assistance: "none", manual: true }), Rating.Again);
});

test("effectiveRecallRating: hint caps correct at Hard; revealed/flip collapses to Again", () => {
	assert.equal(effectiveRecallRating({ rating: Rating.Good, assistance: "hint", manual: false }), Rating.Hard);
	assert.equal(effectiveRecallRating({ rating: Rating.Again, assistance: "hint", manual: false }), Rating.Again);
	assert.equal(effectiveRecallRating({ rating: Rating.Good, assistance: "revealed", manual: false }), Rating.Again);
});

test("effectiveRecallRating: manual self-report is never unassisted evidence", () => {
	// /anki:good without an objective answer is conservative: at most Hard.
	assert.equal(effectiveRecallRating({ rating: Rating.Good, assistance: "none", manual: true }), Rating.Hard);
	assert.equal(effectiveRecallRating({ rating: Rating.Good, assistance: "hint", manual: true }), Rating.Hard);
	assert.equal(effectiveRecallRating({ rating: Rating.Good, assistance: "revealed", manual: true }), Rating.Again);
});
