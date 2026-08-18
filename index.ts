import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Rating } from "fsrs.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PiSdkLlmClient, type PiSdkRuntimeFactory } from "./pi-sdk-llm.ts";
import { AUTO_DETECT_MODELS, DEFAULTS, loadConfig, type PetConfig, type ThinkingLevel } from "./config.ts";
import { advanceReview, advanceReviewDirectional, appendGenLog, bumpStat, computeMasteryStage, consumeReplacement, contentFingerprint, countTodayNew, dueDirection, directionFsrsState, enqueueReplacement, getDueItem, getGenLog, insertItem, knownList, markShown, openDb, pendingReplacementTypes, replacementKnownList, SCHEDULABLE, setStat, touchClient, touchStreak, type ItemRow } from "./db.ts";
import { EMPTY_SENTENCE_CYCLE, activeItem, getRuntimeState, latestMasteredItem, myCoordinatorId, pacingReady, resetPacing, setRuntimeState, type AssistanceLevel, type PendingAttempt, type RecallDirection, type RuntimeState } from "./runtime-state.ts";
import { effectiveRecallRating, quarantineCorruptFsrs, scheduleNext } from "./fsrs.ts";
import { buildConversation } from "./conversation.ts";
import { MAX_LESSON_REVISIONS, critiqueLesson, evaluateAttempt, evaluateSentenceAttempt, generateLesson, generateReplacement, type AnswerEvaluation, type GeneratedItem, type LessonDecision, type ReplacementDecision, type SentenceEvaluation } from "./llm.ts";
import { FACES, TYPE_LABELS, formatStatusLine, parseJsonCol, recallQuestionText, renderCard, sentenceExercise, sentenceQuestionText, spellingComparisonLines, type SentenceExerciseView } from "./render.ts";
import { ensureSentenceCycle, ensureSentenceExercise, insertEvaluatedAttempt } from "./sentence-cycle.ts";
import { dbFilePath, isSyncEnabled, peekRemoteNewer, pullIfNewer, pushSnapshot } from "./sync.ts";
import { computeLearnerProfile, deriveBudget, formatAttemptLogBlock, formatProfileStatsLine, recentAttemptLog, smoothBudget, type AdaptiveContext } from "./learner-profile.ts";

export { contentFingerprint };

// -- Timing & pacing knobs (closure orchestration) ---------------------------

/**
 * Single global learning slot shared across every concurrent Pi session.
 * One row (id=1) in SQLite is the single source of truth; each process keeps
 * only a local cache of the active card for rendering. State transitions that
 * must happen at most once globally (rating, skip, claiming a due card) run in
 * short `BEGIN IMMEDIATE` transactions with optimistic CAS checks.
 */

/** Expiry and renewal cadence of the coordinator lease. */
const COORDINATOR_LEASE_MS = 15_000;
const COORDINATOR_HEARTBEAT_MS = 5_000;
const GENERATION_LEASE_MS = 5 * 60_000;
/** How often each process polls SQLite for cross-session changes. */
const SYNC_POLL_MS = 1000;
/** Grace window a session has to own an in-flight replacement generation. */
const REPLACEMENT_GRACE_MS = 8000;
/** Keep corrective feedback readable before automatically surfacing the next card. */
const AGAIN_FEEDBACK_GRACE_MS = 15_000;
const ANSWER_THINKING_INTERVAL_MS = 120;
const ANSWER_THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// -- Extension ------------------------------------------------------------

export interface KaomojiEnglishTutorExtensionOptions {
	/** Dependency injection seam for isolated SDK transport tests. */
	runtimeFactory?: PiSdkRuntimeFactory;
}

export default function piEnglishAnkiExtension(
	pi: ExtensionAPI,
	options: KaomojiEnglishTutorExtensionOptions = {},
) {
	const llm = new PiSdkLlmClient(options.runtimeFactory);

	// -- State ------------------------------------------------------------
	let config: PetConfig = { ...DEFAULTS };
	const statsLine = (database: DatabaseSync) => formatStatusLine(database, config.dailyNewLimit);
	let db: DatabaseSync | null = null;
	let resolvedModelName = "";
	let lastError = "";
	let pendingLLMCall = false;
	let pendingLLMCallAt = 0;
	let lastRejectedConversation = "";
	let manualTeachTopic = "";
	let lastRejectedReplacementKey = "";
	let sessionGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let answerThinkingTimer: ReturnType<typeof setInterval> | undefined;
	/** Raw lines of the latest real widget render; the judging animation overlays these. */
	let lastWidgetLines: string[] = [];
	/** While true, the judging animation owns the widget and other renders are dropped. */
	let answerJudging = false;
	let latestCtx: ExtensionContext | undefined;
	/** Per-runtime identity; distinct even when two processes open the same logical session. */
	const instanceToken = randomUUID();
	/** Current session id, for the coordinator lease identity. */
	let sessionId = "";
	/** My `sessionId::instanceToken` coordinator identity. */
	let myId = "";
	let lastCoordinatorRenewal = 0;
	/** Last active_version we rendered locally (to detect cross-session card changes). */
	let localVersion = -1;
	/** Cached `PRAGMA data_version` to avoid redundant SQLite reads. */
	let lastDataVersion: number | null = null;
	/** Most recently shown card awaiting a rating/skip decision (mirrors the global slot). */
	let pendingItemId: number | null = null;
	/** Whether the pending card is currently showing its answer side (local-only). */
	let pendingFlipped = false;
	/** Whether the pending card is a review (vs first showing / training). */
	let pendingIsReview = false;
	let pendingDirection: RecallDirection = "forward";
	let pendingAssistance: AssistanceLevel = "none";

	function isCtxStale(ctx: ExtensionContext): boolean {
		try {
			void ctx.hasUI;
			return false;
		} catch {
			return true;
		}
	}

	function resetState() {
		lastError = "";
		pendingLLMCall = false;
		pendingLLMCallAt = 0;
		lastRejectedConversation = "";
		lastRejectedReplacementKey = "";
		resolvedModelName = "";
	}

	function clearPendingLocals() {
		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		pendingDirection = "forward";
		pendingAssistance = "none";
	}

	/** Clear a locally stuck call after the global generation lease has had time to expire. */
	function resetHungLlmCall(): boolean {
		if (!pendingLLMCall || Date.now() - pendingLLMCallAt < 180_000) return false;
		pendingLLMCall = false;
		pendingLLMCallAt = 0;
		if (db) setStat(db, "last_gen_status", "hung_llm_reset");
		return true;
	}

	function stopTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function stopAnswerThinking() {
		answerJudging = false;
		if (answerThinkingTimer) clearInterval(answerThinkingTimer);
		answerThinkingTimer = undefined;
	}

	function startAnswerThinking(ctx: ExtensionContext, expectedGeneration: number) {
		stopAnswerThinking();
		// Overlay the spinner on the card being judged so the widget keeps a
		// stable height; replacing the card with a bare 2-line spinner collapses
		// and re-expands the layout on every interleaved render (flicker).
		const base = lastWidgetLines;
		let frame = 0;
		const render = () => {
			if (sessionGeneration !== expectedGeneration || isCtxStale(ctx)) {
				stopAnswerThinking();
				return;
			}
			updateWidget(ctx, FACES.review, [
				...base,
				`${ANSWER_THINKING_FRAMES[frame % ANSWER_THINKING_FRAMES.length]} 正在判断你的答案…`,
			], true);
			frame++;
		};
		answerJudging = true;
		render();
		answerThinkingTimer = setInterval(render, ANSWER_THINKING_INTERVAL_MS);
		answerThinkingTimer.unref?.();
	}

	function intervalMs(): number {
		return Math.max(0, config.intervalMinutes) * 60_000;
	}

	async function syncAfterTick() {
		if (!db) return;
		try {
			const r = await pushSnapshot(db);
			if (r.status === "pushed") appendGenLog(db, `sync_pushed: ${r.localTs ?? ""}`);
			else if (r.status === "remote_newer") appendGenLog(db, "sync_remote_newer: 云端有更新的进度，/anki:pull 拉取");
			else if (r.status === "error") appendGenLog(db, `sync_error: ${r.message ?? ""}`);
		} catch { /* sync must never break the tick */ }
	}

	function scheduleTimer(delay = intervalMs()) {
		stopTimer();
		if (!latestCtx || config.intervalMinutes <= 0 || db == null || activeItem(db) != null) return;
		const state = getRuntimeState(db);
		const pacingDelay = state.next_check_at
			? new Date(state.next_check_at).getTime() - Date.now()
			: 0;
		const effectiveDelay = pacingDelay > 0 ? pacingDelay : delay;
		timer = setTimeout(() => {
			timer = undefined;
			void runTimerTick().then(syncAfterTick, syncAfterTick);
		}, Math.max(0, effectiveDelay));
		timer.unref?.();
	}

	async function runTimerTick() {
		const ctx = latestCtx;
		const generation = sessionGeneration;
		if (!ctx || isCtxStale(ctx) || config.intervalMinutes <= 0) return;
		if (pendingLLMCall && !resetHungLlmCall()) {
			scheduleTimer(Math.min(30_000, intervalMs()));
			return;
		}
		try {
			await petTick(ctx);
		} catch (err) {
			console.error(`[pi-english-anki] Timer tick failed: ${err}`);
		}
		if (sessionGeneration !== generation) return;
		// Keep re-evaluating unless leaving a locally-rated card up for this session.
		if (pendingItemId == null) scheduleTimer();
	}


	/** Close the session-scoped SQLite connection before reload/switch/exit. */
	function closeDb() {
		stopPolling();
		const current = db;
		db = null;
		if (!current) return;
		try {
			current.close();
		} catch (err) {
			console.error(`[pi-english-anki] Failed to close DB: ${err}`);
		}
	}

	/** Attach this session to the freshly opened DB: identity, card render, polling. */
	function attachDb(ctx: ExtensionContext) {
		resolveModel(ctx);
		if (!db) return;
		ensureCoordinator(new Date(), true);
		setStat(db, "pet_alive", new Date().toISOString());
		setStat(db, "pet_config_model", `${config.provider}/${config.model}`);
		touchClient(db, myId);
		// Rebuild the active global card so this session converges immediately.
		if (activeItem(db)) {
			renderGlobalCard(ctx);
		} else if (localVersion < 0) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
		}
		startPolling();
	}

	// -- Coordinator lease & cross-session sync ----------------------------

	/** Stop the cross-session poll timer. */
	function stopPolling() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	}

	function leaseMs(): number {
		return COORDINATOR_LEASE_MS;
	}

	/** I hold the current, unexpired coordinator lease. */
	function iAmCoordinator(state: RuntimeState, now: Date): boolean {
		return Boolean(
			myId &&
			state.coordinator === myId &&
			state.coordinator_until &&
			now.getTime() < new Date(state.coordinator_until).getTime()
		);
	}

	/** Acquire/renew leadership, or force takeover after real user activity. */
	function ensureCoordinator(now = new Date(), force = false): boolean {
		if (!db || !myId) return false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			const expired = !state.coordinator || !state.coordinator_until ||
				now.getTime() >= new Date(state.coordinator_until).getTime();
			if (!force && state.coordinator !== myId && !expired) {
				db.exec("ROLLBACK");
				return false;
			}
			const changedOwner = state.coordinator !== myId;
			setRuntimeState(db, {
				coordinator: myId,
				coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(),
				last_activity: now.toISOString(),
				...(changedOwner ? { generation_token: null, generation_until: null } : {}),
			});
			db.exec("COMMIT");
			lastCoordinatorRenewal = now.getTime();
			return true;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Coordinator lease failed: ${err}`);
			return false;
		}
	}

	/** Release only this runtime's ownership; never disturb a newer session. */
	function releaseCoordinator() {
		if (!db || !myId) return;
		db.prepare(
			"UPDATE runtime_state SET coordinator = NULL, coordinator_until = NULL, generation_token = NULL, generation_until = NULL WHERE id = 1 AND coordinator = ?",
		).run(myId);
	}

	/** Claim one generation token without holding a transaction across the LLM call. */
	function claimGeneration(now = new Date()): string | null {
		if (!ensureCoordinator(now)) return null;
		const token = randomUUID();
		try {
			db!.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db!);
			const generationBusy = Boolean(
				state.generation_token && state.generation_until &&
				now.getTime() < new Date(state.generation_until).getTime()
			);
			if (!iAmCoordinator(state, now) || generationBusy) {
				db!.exec("ROLLBACK");
				return null;
			}
			setRuntimeState(db!, {
				generation_token: token,
				generation_until: new Date(now.getTime() + GENERATION_LEASE_MS).toISOString(),
			});
			db!.exec("COMMIT");
			return token;
		} catch (err) {
			try { db!.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Generation lease failed: ${err}`);
			return null;
		}
	}

	function ownsGeneration(state: RuntimeState, token: string, now = new Date()): boolean {
		return Boolean(
			iAmCoordinator(state, now) &&
			state.generation_token === token &&
			state.generation_until &&
			now.getTime() < new Date(state.generation_until).getTime()
		);
	}

	function releaseGeneration(token: string) {
		if (!db) return;
		db.prepare(
			"UPDATE runtime_state SET generation_token = NULL, generation_until = NULL WHERE id = 1 AND coordinator = ? AND generation_token = ?",
		).run(myId, token);
	}

	/** Rebuild persisted sentence-correction teaching after polls, reattachment, or reload. */
	function sentenceCorrectionLines(item: ItemRow, state: RuntimeState): string[] | undefined {
		if (
			!db || item.type !== "sentence" || state.active_cycle_outcome !== "again" ||
			state.active_retry_count <= 0 || !state.active_review_cycle_id || state.active_exercise_id == null
		) return undefined;
		const attempt = db.prepare(
			"SELECT verdict,answer_text,error_tags_json,feedback_json FROM attempts WHERE item_id = ? AND review_cycle_id = ? AND exercise_id = ? AND verdict IN ('partial','incorrect') ORDER BY completed_at DESC,id DESC LIMIT 1",
		).get(item.id, state.active_review_cycle_id, state.active_exercise_id) as { verdict: "partial" | "incorrect"; answer_text: string | null; error_tags_json: string | null; feedback_json: string | null } | undefined;
		if (!attempt) return undefined;
		const feedback = parseJsonCol<{ feedback?: string; correctedAnswer?: string }>(attempt.feedback_json);
		const errorTags = parseJsonCol<string[]>(attempt.error_tags_json) ?? [];
		const exercise = sentenceExercise(item);
		if (!exercise) return undefined;
		const lines = [
			attempt.verdict === "partial"
				? `△ 差一点：${feedback?.feedback || "有一个小问题"}`
				: `✗ 再试一次：${feedback?.feedback || "意思或表达还不对"}`,
		];
		lines.push(...spellingComparisonLines(attempt.answer_text, feedback?.correctedAnswer, errorTags));
		if (state.active_retry_count === 1) lines.push(`提示：${exercise.hint}`);
		if (state.active_retry_count >= 2) lines.push(`参考：${feedback?.correctedAnswer || exercise.reference}`);
		lines.push(...renderCard(item, state.active_kind === "review", FACES.error, false, "forward"));
		return lines;
	}

	/** Bump the global card version and cache the rendered state locally. */
	function recordRendered(state: RuntimeState | undefined) {
		if (!state) {
			localVersion = -1;
			return;
		}
		localVersion = state.active_version;
	}

	/** Cloze has no teach face: a legacy persisted teach state still quizzes. */
	function effectiveIsReview(item: ItemRow, state: RuntimeState): boolean {
		return state.active_kind === "review" || item.type === "cloze";
	}

	/**
	 * Re-render the widget from the global active card. Returns true when the
	 * global card changed (so the caller knows a stale local panel should close).
	 */
	function renderGlobalCard(ctx: ExtensionContext): boolean {
		if (!db) return false;
		let state = getRuntimeState(db);
		const item = activeItem(db);
		if (item?.type === "sentence") state = ensureSentenceCycle(db, item, state);
		const changed = state.active_version !== localVersion;
		if (item && state.active_kind) {
			const isReview = effectiveIsReview(item, state);
			pendingItemId = state.active_item_id;
			pendingIsReview = isReview;
			pendingDirection = state.active_direction;
			if (changed) {
				pendingFlipped = state.active_assistance_level === "revealed";
				pendingAssistance = state.active_assistance_level;
			}
			const correction = sentenceCorrectionLines(item, state);
			const face = correction ? FACES.error : isReview ? FACES.review : FACES.teach;
			const lines = correction ?? renderCard(item, isReview, face, pendingFlipped, pendingDirection);
			lines.push(statsLine(db));
			updateWidget(ctx, face, lines);
			recordRendered(state);
		} else {
			// No global card: reflect cleared state (respecting pacing status line).
			clearPendingLocals();
			if (changed || localVersion < 0) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
				recordRendered(state);
			}
		}
		return changed;
	}

	/**
	 * Poll SQLite for cross-session changes (~1s) using PRAGMA data_version.
	 * Re-renders the global card and resumes timer work after another session
	 * rates/skips the active card so every process converges on the same card.
	 */
	function startPolling() {
		stopPolling();
		if (!db || !latestCtx) return;
		try {
			lastDataVersion = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
			renderGlobalCard(latestCtx);
		} catch {
			lastDataVersion = null;
		}
		const tick = () => {
			if (!db || !latestCtx || isCtxStale(latestCtx)) {
				pollTimer = undefined;
				return;
			}
			try {
				const version = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
				if (lastDataVersion === null || version !== lastDataVersion) {
					lastDataVersion = version;
					const previousActive = pendingItemId;
					renderGlobalCard(latestCtx);
					const state = getRuntimeState(db);
					if (state.active_item_id != null) {
						stopTimer();
					} else if (previousActive != null && config.intervalMinutes > 0) {
						// scheduleTimer respects the persisted next_check_at pacing boundary.
						scheduleTimer(0);
					}
				}
				const state = getRuntimeState(db);
				const generationExpired = Boolean(
					pendingLLMCall && (!state.generation_until || Date.now() >= new Date(state.generation_until).getTime())
				);
				if (!generationExpired && state.coordinator === myId && Date.now() - lastCoordinatorRenewal >= COORDINATOR_HEARTBEAT_MS) {
					ensureCoordinator(new Date());
				}
			} catch (err) {
				console.error(`[pi-english-anki] Sync poll failed: ${err}`);
			}
			pollTimer = setTimeout(tick, SYNC_POLL_MS);
			(pollTimer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll = true;
			pollTimer.unref?.();
		};
		pollTimer = setTimeout(tick, SYNC_POLL_MS);
		(pollTimer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll = true;
		pollTimer.unref?.();
	}


	/**
	 * Resolve the lesson model: explicit config first, then auto-detect among
	 * models whose provider has configured auth (logged in / API key present),
	 * falling back to the current session model.
	 */
	function resolveModel(ctx: ExtensionContext): { provider: string; model: string; fromSession: boolean } | undefined {
		const withAuth = (m: { provider: string; id: string }) =>
			ctx.modelRegistry.hasConfiguredAuth(m as never);

		if (config.provider && config.model) {
			const found = ctx.modelRegistry.find(config.provider, config.model);
			if (found && withAuth(found)) {
				resolvedModelName = `${config.provider}/${config.model}`;
				return { provider: config.provider, model: config.model, fromSession: false };
			}
		}

		const available = ctx.modelRegistry.getAvailable().filter(withAuth);
		for (const candidateId of AUTO_DETECT_MODELS) {
			const match = available.find((m) => m.id === candidateId);
			if (match) {
				resolvedModelName = `${match.provider}/${match.id}`;
				return { provider: match.provider, model: match.id, fromSession: false };
			}
		}

		// Last resort: the model currently driving this session (it is by
		// definition authenticated and reachable).
		if (ctx.model) {
			resolvedModelName = `${ctx.model.provider}/${ctx.model.id}（当前会话）`;
			return { provider: ctx.model.provider, model: ctx.model.id, fromSession: true };
		}

		resolvedModelName = "";
		return undefined;
	}

	function updateWidget(ctx: ExtensionContext, _face: string, lines: string[], judgingFrame = false) {
		// While the answer-judging animation is running it owns the widget: drop
		// interleaved renders (sync-poll card paints, stray pet ticks) so the
		// widget cannot alternate between the card and the spinner (flicker).
		if (answerJudging && !judgingFrame) return;
		if (isCtxStale(ctx)) return;
		if (!ctx.hasUI) return;
		if (!config.showWidget) {
			if (!judgingFrame) lastWidgetLines = [];
			ctx.ui.setWidget("pi-english-anki", undefined);
			return;
		}
		const accent = (s: string): string => {
			try {
				return ctx.ui.theme.fg("thinkingXhigh", s);
			} catch {
				return s;
			}
		};
		const width = Math.max(20, (process.stdout.columns || 120) - 2);
		const out = lines.filter(Boolean).flatMap((line) => wrapTextWithAnsi(line, width));
		if (!judgingFrame) lastWidgetLines = out.length === 0 ? [] : lines;
		if (out.length === 0) {
			ctx.ui.setWidget("pi-english-anki", undefined);
			return;
		}
		ctx.ui.setWidget("pi-english-anki", out.map(accent), { placement: "belowEditor" });
	}

	/** Whether an already-stored review/new card can be claimed right now. */
	function hasReadyQueuedCard(now: Date): boolean {
		if (!db) return false;
		const dueReview = db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 1 ${SCHEDULABLE} LIMIT 1`)
			.get(now.toISOString());
		if (dueReview) return true;
		if (pendingReplacementTypes(db).length > 0) return true;
		// Replacement queued-new is always claimable (quota-free).
		const replacementNew = db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 0 AND introduction_kind = 'replacement' ${SCHEDULABLE} LIMIT 1`)
			.get(now.toISOString());
		if (replacementNew) return true;
		if (config.dailyNewLimit > 0 && countTodayNew(db, now) >= config.dailyNewLimit) return false;
		return Boolean(db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 0 ${SCHEDULABLE} LIMIT 1`).get(now.toISOString()));
	}

	/** Atomically select, mark, and activate the next due card. */
	function claimDueItem(now: Date, reviewsOnly = false): ItemRow | undefined {
		if (!db) return undefined;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			if (state.active_item_id != null || !pacingReady(state, now)) {
				db.exec("ROLLBACK");
				return undefined;
			}
			// Review cards take priority over queued-new cards.
			let due = db.prepare(`SELECT * FROM items WHERE due_at <= ? AND shown = 1 ${SCHEDULABLE} ORDER BY due_at ASC, id ASC LIMIT 1`)
				.get(now.toISOString()) as ItemRow | undefined;
			let isReview = true;
			if (!due && reviewsOnly) {
				db.exec("ROLLBACK");
				return undefined;
			}
			if (!due) {
				// Replacement queued-new cards are quota-free and take priority over planned.
				const replacement = db.prepare(`SELECT * FROM items WHERE due_at <= ? AND shown = 0 AND introduction_kind = 'replacement' ${SCHEDULABLE} ORDER BY due_at ASC, id ASC LIMIT 1`)
					.get(now.toISOString()) as ItemRow | undefined;
				if (replacement) {
					due = replacement;
					isReview = false;
				} else {
					// Enforce the planned first-display quota (0 = unlimited, for compatibility).
					if (config.dailyNewLimit > 0 && countTodayNew(db, now) >= config.dailyNewLimit) {
						db.exec("ROLLBACK");
						return undefined;
					}
					due = db.prepare(`SELECT * FROM items WHERE due_at <= ? AND shown = 0 AND (introduction_kind = 'planned' OR introduction_kind IS NULL) ${SCHEDULABLE} ORDER BY due_at ASC, id ASC LIMIT 1`)
						.get(now.toISOString()) as ItemRow | undefined;
					isReview = false;
				}
			}
			if (!due) {
				db.exec("ROLLBACK");
				return undefined;
			}
			if (!isReview) {
				markShown(db, due.id);
				db.prepare("UPDATE items SET introduced_at = ?, introduction_kind = COALESCE(introduction_kind, 'planned') WHERE id = ?")
					.run(now.toISOString(), due.id);
				bumpStat(db, "total_learned", 1);
				touchStreak(db, now);
			}
			const direction: RecallDirection = (due.type === "word" || due.type === "phrase") && isReview ? dueDirection(db, due.id, now) : "forward";
			setRuntimeState(db, {
				active_item_id: due.id,
				// Cloze cards quiz from the very first showing: the blank + lemma hint
				// is self-contained, so a teach face would only leak the answer and the
				// first attempt is genuine mastery evidence.
				active_kind: isReview || due.type === "cloze" ? "review" : "teach",
				active_direction: direction,
				active_version: state.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				next_check_at: now.toISOString(),
			});
			db.exec("COMMIT");
			return db.prepare("SELECT * FROM items WHERE id = ?").get(due.id) as unknown as ItemRow | undefined;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Due-card claim failed: ${err}`);
			return undefined;
		}
	}

	/** Render an item only when it is still the authoritative global card. */
	function showItem(ctx: ExtensionContext, item: ItemRow): boolean {
		if (!db) return false;
		let state = getRuntimeState(db);
		if (state.active_item_id !== item.id || !state.active_kind) return false;
		if (item.type === "sentence") state = ensureSentenceCycle(db, item, state);
		const isReview = effectiveIsReview(item, state);
		pendingItemId = item.id;
		pendingFlipped = false;
		pendingIsReview = isReview;
		pendingDirection = state.active_direction;
		pendingAssistance = state.active_assistance_level;
		recordRendered(state);
		const face = isReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, isReview, face, false, pendingDirection);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		if (config.verbose) {
			ctx.ui.notify(`${isReview ? "复习" : "新学"}：${item.text} — ${item.meaning}`, "info");
		}
		return true;
	}

	/** Populate the local projection when another session activated a card before this session observed it. */
	function hydratePending(ctx: ExtensionContext) {
		if (pendingItemId == null && db && getRuntimeState(db).active_item_id != null) {
			renderGlobalCard(ctx);
		}
	}

	/** Toggle the pending card between its question and answer sides. */
	function flipPending(ctx: ExtensionContext): boolean {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		let state = getRuntimeState(db);
		if (state.active_item_id !== pendingItemId || state.active_version !== localVersion) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return true;
		if (item.type === "sentence") state = ensureSentenceCycle(db, item, state);
		pendingFlipped = !pendingFlipped;
		if (pendingFlipped) {
			pendingAssistance = "revealed";
			if (item.type === "sentence") {
				db.prepare("UPDATE runtime_state SET active_cycle_outcome = 'again', active_assistance_level = 'revealed', active_version = active_version + 1 WHERE id = 1 AND active_item_id = ? AND active_version = ?")
					.run(item.id, state.active_version);
				state = getRuntimeState(db);
				recordRendered(state);
			} else {
				// Word/phrase: persist the reveal so it survives reload/reattach (P0-2).
				db.prepare("UPDATE runtime_state SET active_assistance_level = 'revealed', active_version = active_version + 1 WHERE id = 1 AND active_item_id = ?")
					.run(item.id);
				recordRendered(getRuntimeState(db));
			}
		}
		const face = pendingIsReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, pendingIsReview, face, pendingFlipped, pendingDirection);
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		return true;
	}

	/** Record a sentence miss without scheduling FSRS; the same level remains active for corrective output. */
	function recordSentenceMiss(
		ctx: ExtensionContext,
		item: ItemRow,
		attempt: PendingAttempt,
		exercise: SentenceExerciseView,
	): boolean {
		if (!db || attempt.sessionGeneration !== sessionGeneration || !attempt.reviewCycleId) return true;
		let retryCount = 0;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			const current = db.prepare("SELECT progress FROM items WHERE id = ?").get(item.id) as { progress: number } | undefined;
			if (
				cur.active_item_id === item.id &&
				cur.active_version === attempt.version &&
				cur.active_review_cycle_id === attempt.reviewCycleId &&
				cur.active_exercise_id === attempt.exerciseId &&
				current?.progress === exercise.level
			) {
				insertEvaluatedAttempt(db, attempt, null, new Date());
				retryCount = cur.active_retry_count + 1;
				setRuntimeState(db, {
					active_cycle_outcome: "again",
					active_retry_count: retryCount,
					active_assistance_level: retryCount >= 2 ? "revealed" : "hint",
					active_version: cur.active_version + 1,
				});
			}
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Sentence-attempt CAS failed: ${err}`);
		}
		renderGlobalCard(ctx);
		return true;
	}

	/** Written sentence output with semantic evaluation and corrective retry. */
	async function answerSentencePending(ctx: ExtensionContext, item: ItemRow, rawText: string, initialState: RuntimeState): Promise<boolean> {
		if (!db) return false;
		const state = ensureSentenceCycle(db, item, initialState);
		const exercise = sentenceExercise(item);
		if (!exercise || !state.active_review_cycle_id || state.active_exercise_id == null) return false;
		const text = rawText.trim();
		if (!text) {
			const face = state.active_kind === "review" ? FACES.review : FACES.teach;
			const lines = renderCard(item, state.active_kind === "review", face, false);
			lines.push(statsLine(db));
			updateWidget(ctx, face, lines);
			return true;
		}
		const attemptBase = {
			itemId: item.id,
			version: state.active_version,
			direction: "forward" as const,
			sessionGeneration,
			answerText: text,
			assistanceLevel: state.active_assistance_level,
			startedAt: new Date().toISOString(),
			reviewCycleId: state.active_review_cycle_id,
			exerciseId: state.active_exercise_id,
			kind: exercise.kind,
			questionText: sentenceQuestionText(exercise),
		};
		startAnswerThinking(ctx, attemptBase.sessionGeneration);
		let result: SentenceEvaluation;
		try {
			result = await evaluateSentenceAttempt(llm, ctx, exercise, text, resolveModel(ctx));
		} finally {
			stopAnswerThinking();
		}
		if (attemptBase.sessionGeneration !== sessionGeneration) {
			renderGlobalCard(ctx);
			return true;
		}
		if (!result.available) {
			renderGlobalCard(ctx);
			ctx.ui.notify("暂时无法可靠判断这个句子；没有记录成绩，请稍后重试或使用 /anki:again", "warning");
			return true;
		}
		const attempt: PendingAttempt = {
			...attemptBase,
			verdict: result.verdict,
			feedback: result.feedback,
			errorTags: result.errorTags,
			correctedAnswer: result.correctedAnswer,
		};
		if (result.verdict !== "correct") return recordSentenceMiss(ctx, item, attempt, exercise);
		const levels = parseJsonCol<string[]>(item.levels) ?? [];
		const finalLevel = exercise.level >= levels.length - 1;
		const cleanRecall = state.active_cycle_outcome === "clean" && state.active_retry_count === 0 && state.active_assistance_level === "none";
		const rating = finalLevel && !cleanRecall ? Rating.Again : Rating.Good;
		const note = finalLevel
			? cleanRecall ? "✓ 独立写对了！" : "✓ 已改对；首次回忆有辅助或错误，本轮按 Again 调度。"
			: `✓ L${exercise.level + 1} 写对了，进入 L${exercise.level + 2}。`;
		ratePending(ctx, rating, note, attempt);
		return true;
	}

	/** Active-recall answer for all cards. Exact matches stay local; semantic variants use the SDK evaluator. */
	async function answerPending(ctx: ExtensionContext, rawText: string): Promise<boolean> {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		const state = getRuntimeState(db);
		if (
			state.active_item_id !== pendingItemId ||
			state.active_version !== localVersion ||
			state.active_direction !== pendingDirection
		) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return true;
		if (item.type === "sentence") return answerSentencePending(ctx, item, rawText, state);
		if (!effectiveIsReview(item, state)) {
			ctx.ui.notify("这是首次展示的新卡，请先用 /anki:flip 翻面查看释义，再选择 /anki:good 或 /anki:skip", "info");
			return true;
		}
		const text = rawText.trim();
		if (!text) {
			const promptText = item.type === "cloze"
				? `✍️ 请补全：${item.text}`
				: pendingDirection === "reverse"
					? `✍️ 请写出「${item.text}」的中文释义`
					: `✍️ 请写出「${item.meaning}」的英文`;
			updateWidget(ctx, FACES.review, [
				`${FACES.review} ${promptText}`,
				"用 /anki:answer <你的答案>，或 /anki:hint 看提示，或 /anki:flip 看答案",
				statsLine(db),
			]);
			return true;
		}

		// Capture every identity field before an LLM await. Later local/global card
		// changes must not redirect this answer to a different item.
		const attemptBase = {
			itemId: item.id,
			version: state.active_version,
			direction: state.active_direction,
			sessionGeneration,
			answerText: text,
			assistanceLevel: pendingAssistance,
			startedAt: new Date().toISOString(),
			questionText: recallQuestionText(item, state.active_direction),
		};
		const norm = (s: string) => item.type === "cloze"
			? s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']+/g, " ").trim().replace(/\s+/g, " ")
			: s.trim().toLowerCase().replace(/\s+/g, " ");
		const target = item.type === "cloze"
			? item.meaning
			: attemptBase.direction === "reverse" ? item.meaning : item.text;
		const exact = norm(text) === norm(target);
		let verdict: PendingAttempt["verdict"] = exact ? "correct" : "incorrect";
		let feedback = "";
		if (!exact) {
			startAnswerThinking(ctx, attemptBase.sessionGeneration);
			let result: AnswerEvaluation;
			try {
				result = await evaluateAttempt(llm, ctx, item, text, resolveModel(ctx), attemptBase.direction);
			} finally {
				stopAnswerThinking();
			}
			if (attemptBase.sessionGeneration !== sessionGeneration) {
				renderGlobalCard(ctx);
				return true;
			}
			if (!result.available) {
				renderGlobalCard(ctx);
				ctx.ui.notify("暂时无法可靠判断这个答案；没有记录成绩，请稍后重试或使用 /anki:again", "warning");
				return true;
			}
			verdict = result.verdict;
			feedback = result.feedback;
		}
		const attempt: PendingAttempt = { ...attemptBase, verdict, feedback };
		// Auto-rate: correct -> Good, miss (partial/incorrect) -> Again.
		const autoRating = verdict === "correct" ? Rating.Good : Rating.Again;
		const recallNote = verdict === "correct"
			? "✓ 答对了！"
			: verdict === "partial"
				? `△ 差一点：${feedback || "有小问题"}（正确：${target}）`
				: `✗ 答案是：${target}`;
		ratePending(ctx, autoRating, recallNote, attempt);
		return true;
	}

	/** Persist a recall exercise template for a word/phrase item (idempotent, groundwork for M3 multi-exercise). */
	function ensureRecallExercise(item: ItemRow) {
		if (!db) return;
		const answer = item.type === "cloze" ? item.meaning : item.text;
		const hint = answer[0] + "_".repeat(Math.max(0, answer.length - 1));
		db.prepare(
			"INSERT OR IGNORE INTO exercises (item_id, kind, schema_version, stage, content_fingerprint, prompt_json, answer_json, hints_json, rubric_json, quality_json, created_at) VALUES (?, 'recall', 1, 'recall', ?, ?, ?, ?, '{}', '{}', ?)",
		).run(
			item.id,
			"recall:" + item.id,
			JSON.stringify(item.type === "cloze" ? { cloze: item.text } : { meaning: item.meaning }),
			JSON.stringify({ acceptedForms: [answer] }),
			JSON.stringify([hint]),
			new Date().toISOString(),
		);
	}

	/** Show a direction-aware hint and persist sentence assistance globally. */
	function hintPending(ctx: ExtensionContext): boolean {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		let state = getRuntimeState(db);
		if (state.active_item_id !== pendingItemId || state.active_version !== localVersion) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return false;
		if (item.type === "sentence") {
			state = ensureSentenceCycle(db, item, state);
			const exercise = sentenceExercise(item);
			if (!exercise) return false;
			db.prepare("UPDATE runtime_state SET active_cycle_outcome = 'again', active_assistance_level = CASE WHEN active_assistance_level = 'revealed' THEN 'revealed' ELSE 'hint' END, active_version = active_version + 1 WHERE id = 1 AND active_item_id = ? AND active_version = ?")
				.run(item.id, state.active_version);
			state = getRuntimeState(db);
			pendingAssistance = state.active_assistance_level;
			recordRendered(state);
			ctx.ui.notify(`提示：${exercise.hint}`, "info");
			return true;
		}
		const hint = item.type === "cloze"
			? item.meaning.split(/\s+/).map((word) => word[0] + "_".repeat(Math.max(0, word.replace(/[^A-Za-z]/g, "").length - 1))).join(" ")
			: pendingDirection === "reverse"
			? item.meaning.split(/([，,；;、/\s]+)/).map((part) => {
				if (!part || /^[，,；;、/\s]+$/.test(part)) return part;
				const chars = Array.from(part);
				return chars[0] + "_".repeat(Math.max(0, chars.length - 1));
			}).join("")
			: item.text.split(/\s+/).map((word) => word[0] + "_".repeat(Math.max(0, word.length - 1))).join(" ");
		if (pendingAssistance === "none") pendingAssistance = "hint";
		// Persist assistance so the scheduling policy survives reload/reattach (P0-2).
		db.prepare("UPDATE runtime_state SET active_assistance_level = CASE WHEN active_assistance_level = 'none' THEN 'hint' ELSE active_assistance_level END, active_version = active_version + 1 WHERE id = 1 AND active_item_id = ?")
			.run(item.id);
		recordRendered(getRuntimeState(db));
		ctx.ui.notify(`提示：${hint}`, "info");
		return true;
	}

	// -- Pet tick ---------------------------------------------------------

	/** Show the sentence card at a given level (0-based). */
	function showSentenceLevel(ctx: ExtensionContext, item: ItemRow, level: number) {
		const shown = { ...item, progress: level } as ItemRow;
		let state = getRuntimeState(db!);
		state = ensureSentenceCycle(db!, shown, state);
		pendingFlipped = false;
		pendingIsReview = state.active_kind === "review";
		pendingDirection = "forward";
		pendingAssistance = state.active_assistance_level;
		recordRendered(state);
		const face = pendingIsReview ? FACES.review : FACES.teach;
		const lines = renderCard(shown, pendingIsReview, face, false);
		lines.push(statsLine(db!));
		updateWidget(ctx, face, lines);
	}

	/** Rate the pending review card; returns true once an action was taken (or a stale action was safely refreshed). */
	function ratePending(ctx: ExtensionContext, rating: Rating, recallNote = "", attempt?: PendingAttempt): boolean {
		// An answer that resumed after reload/session switch belongs to the old runtime.
		if (attempt && attempt.sessionGeneration !== sessionGeneration) return true;
		hydratePending(ctx);
		if (!db) return false;
		const expectedItemId = attempt?.itemId ?? pendingItemId;
		if (expectedItemId == null) return false;
		const expectedVersion = attempt?.version ?? localVersion;
		const expectedDirection = attempt?.direction ?? pendingDirection;
		let assistanceLevel = attempt?.assistanceLevel ?? pendingAssistance;

		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(expectedItemId) as ItemRow | undefined;
		if (!item || item.shown === 0) {
			clearPendingLocals();
			return true;
		}

		const now = new Date();
		const levels = parseJsonCol<string[]>(item.levels);
		let stateAtStart = getRuntimeState(db);
		if (item.type === "sentence") {
			stateAtStart = ensureSentenceCycle(db, item, stateAtStart);
			assistanceLevel = attempt?.assistanceLevel ?? stateAtStart.active_assistance_level;
		}
		// Bind the rating to the exact item/version/direction observed before any LLM await.
		if (
			stateAtStart.active_item_id !== item.id ||
			stateAtStart.active_version !== expectedVersion ||
			stateAtStart.active_direction !== expectedDirection
		) {
			clearPendingLocals();
			renderGlobalCard(ctx);
			return true;
		}

		// A sentence Good must come from an evaluated written answer; manual Again remains an escape hatch.
		if (item.type === "sentence" && rating === Rating.Good && !attempt) {
			ctx.ui.notify("句子卡请先用 /anki:answer <英文> 完成输出；也可以用 /anki:again 结束本轮", "info");
			return true;
		}

		// A correct written answer advances progressive levels. Manual Again rates the whole card immediately.
		if (item.type === "sentence" && levels && levels.length > 1) {
			const nextProgress = rating === Rating.Good && item.progress < levels.length - 1
				? item.progress + 1
				: null;
			if (nextProgress != null) {
				let applied = false;
				try {
					db.exec("BEGIN IMMEDIATE");
					const cur = getRuntimeState(db);
					const current = db.prepare("SELECT progress FROM items WHERE id = ?").get(item.id) as { progress: number } | undefined;
					if (
						cur.active_item_id === item.id &&
						cur.active_version === expectedVersion &&
						cur.active_direction === expectedDirection &&
						current?.progress === item.progress &&
						(!attempt || (
							cur.active_review_cycle_id === attempt.reviewCycleId &&
							cur.active_exercise_id === attempt.exerciseId
						))
					) {
						if (attempt) insertEvaluatedAttempt(db, attempt, null, now);
						db.prepare("UPDATE items SET progress = ?, due_at = ? WHERE id = ?").run(nextProgress, now.toISOString(), item.id);
						const nextItem = { ...item, progress: nextProgress } as ItemRow;
						const nextExercise = sentenceExercise(nextItem);
						const nextExerciseId = nextExercise ? ensureSentenceExercise(db, nextItem, nextExercise) : null;
						setRuntimeState(db, {
							active_kind: cur.active_kind,
							active_direction: "forward",
							active_version: cur.active_version + 1,
							active_exercise_id: nextExerciseId,
							active_retry_count: 0,
							active_assistance_level: "none",
							next_check_at: now.toISOString(),
						});
						applied = true;
					}
					db.exec("COMMIT");
				} catch (err) {
					try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
					console.error(`[pi-english-anki] Sentence CAS failed: ${err}`);
				}
				if (!applied) {
					clearPendingLocals();
					renderGlobalCard(ctx);
					return true;
				}
				const state = getRuntimeState(db);
				recordRendered(state);
				const refreshed = db.prepare("SELECT * FROM items WHERE id = ?").get(item.id) as unknown as ItemRow;
				showSentenceLevel(ctx, refreshed, nextProgress);
				pendingItemId = item.id;
				return true;
			}
			// Full-level Good and any Again hand over to FSRS.
		}

		// Full rating: one-shot, atomic, applies at most once globally.
		// Word/phrase: assistance-aware effective rating + per-direction schedule (P0-1/P0-2).
		// Cloze: assistance-aware rating but a single-direction FSRS state like sentences.
		const isRecall = item.type !== "sentence";
		const usesDirection = item.type === "word" || item.type === "phrase";
		const effective = isRecall
			? effectiveRecallRating({ rating, assistance: assistanceLevel, manual: !attempt })
			: rating;
		const stateForSchedule = usesDirection
			? (directionFsrsState(db, item.id, expectedDirection) ?? item.fsrs_state)
			: item.fsrs_state;
		const next = scheduleNext(stateForSchedule, now, effective);
		if ("corrupt" in next) {
			if (db) quarantineCorruptFsrs(db, item.id, stateForSchedule ?? "", next.error, now);
			clearPendingLocals();
			if (!isCtxStale(ctx)) {
				ctx.ui.notify(`该卡片 FSRS 数据损坏，已隔离，不会重复出现。原始数据已保留。`, "warning");
				renderGlobalCard(ctx);
			}
			scheduleTimer(0);
			return true;
		}
		let applied = false;
		let hasImmediateNext = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (
				cur.active_item_id === item.id &&
				cur.active_version === expectedVersion &&
				cur.active_direction === expectedDirection &&
				(!attempt || item.type !== "sentence" || (
					cur.active_review_cycle_id === attempt.reviewCycleId &&
					cur.active_exercise_id === attempt.exerciseId
				))
			) {
				if (item.type === "sentence" && rating === Rating.Again) {
					db.prepare("UPDATE items SET progress = 0 WHERE id = ?").run(item.id);
				}
				if (attempt) {
					if (item.type !== "sentence") ensureRecallExercise(item);
					insertEvaluatedAttempt(db, attempt, effective === Rating.Good ? "good" : effective === Rating.Hard ? "hard" : "again", now);
				} else if (item.type === "sentence" && cur.active_review_cycle_id) {
					const linked = db.prepare(
						"UPDATE attempts SET explicit_rating = 'again', rated_at = ? WHERE id = (SELECT id FROM attempts WHERE review_cycle_id = ? AND explicit_rating IS NULL ORDER BY completed_at DESC, id DESC LIMIT 1)",
					).run(now.toISOString(), cur.active_review_cycle_id);
					if (Number(linked.changes) === 0) {
						const selfReportExercise = sentenceExercise(item);
						db.prepare(
							"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, explicit_rating, started_at, completed_at, rated_at, question_text) VALUES (?, ?, ?, ?, ?, ?, ?, 'sentence_self_report', 'forward', ?, 'self_report', 'again', ?, ?, ?, ?)",
						).run(
							randomUUID(), item.id, cur.active_exercise_id, cur.active_review_cycle_id,
							"sentence_self_report:" + cur.active_review_cycle_id + ":" + expectedVersion,
							expectedVersion, expectedVersion, cur.active_assistance_level,
							now.toISOString(), now.toISOString(), now.toISOString(),
							selfReportExercise ? sentenceQuestionText(selfReportExercise) : null,
						);
					}
				} else if (item.type !== "sentence") {
					// Manual word/phrase self-report: recorded separately (kind=recall_self_report)
					// with the conservatively applied rating; never objective evidence.
					db.prepare(
						"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, explicit_rating, started_at, completed_at, rated_at, question_text) VALUES (?, ?, NULL, ?, ?, ?, ?, 'recall_self_report', ?, ?, 'self_report', ?, ?, ?, ?, ?)",
					).run(
						randomUUID(), item.id, randomUUID(), `recall_self_report:${item.id}:${expectedVersion}`,
						expectedVersion, expectedVersion, expectedDirection, assistanceLevel,
						effective === Rating.Again ? "again" : "hard",
						now.toISOString(), now.toISOString(), now.toISOString(),
						recallQuestionText(item, expectedDirection),
					);
				}
				if (isRecall) {
					if (usesDirection) {
						advanceReviewDirectional(db, item.id, expectedDirection, next.state, next.due, item.reviews + 1, now);
					} else {
						advanceReview(db, item.id, next.state, next.due, item.reviews + 1);
					}
				} else {
					advanceReview(db, item.id, next.state, next.due, item.reviews + 1);
				}
				// Mastery evidence follows the objective verdict, not the scheduled rating:
				// a hint-assisted correct stays assisted evidence even when scheduled Hard;
				// manual self-reports are not objective evidence at all.
				const m = db.prepare("SELECT stage, unassisted_good, assisted_good, consecutive_again FROM mastery_state WHERE item_id = ?").get(item.id) as { stage: string; unassisted_good: number; assisted_good: number; consecutive_again: number } | undefined;
				const prevStage = m?.stage ?? "exposure";
				const assisted = assistanceLevel !== "none";
				const objectiveCorrect = attempt != null && attempt.verdict === "correct";
				const newGood = effective === Rating.Again
					? 0
					: Number(m?.unassisted_good ?? 0) + (objectiveCorrect && !assisted ? 1 : 0);
				// Assisted evidence counts hint-level only; answering after a reveal is not recall.
				const newAssistedGood = Number(m?.assisted_good ?? 0) + (objectiveCorrect && assistanceLevel === "hint" ? 1 : 0);
				const newAgain = effective === Rating.Again
					? Number(m?.consecutive_again ?? 0) + 1
					: effective === Rating.Good ? 0 : Number(m?.consecutive_again ?? 0);
				const stage = effective === Rating.Again
					? computeMasteryStage(prevStage, newGood, true)
					: objectiveCorrect && !assisted
						? computeMasteryStage(prevStage, newGood, false)
						: prevStage;
				const exerciseKind = attempt?.kind ?? (item.type === "sentence" ? "sentence_self_report" : "recall");
				if (m) {
					db.prepare("UPDATE mastery_state SET stage = ?, unassisted_good = ?, assisted_good = ?, consecutive_again = ?, last_exercise_kind = ?, updated_at = ? WHERE item_id = ?")
						.run(stage, newGood, newAssistedGood, newAgain, exerciseKind, now.toISOString(), item.id);
				} else {
					db.prepare("INSERT INTO mastery_state (item_id, stage, unassisted_good, assisted_good, consecutive_again, last_exercise_kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
						.run(item.id, stage, newGood, newAssistedGood, newAgain, exerciseKind, now.toISOString());
				}
				bumpStat(db, "total_reviews", 1);
				touchStreak(db, now);
				hasImmediateNext = hasReadyQueuedCard(now);
				const nextCheck = hasImmediateNext
					? new Date(now.getTime() + (effective === Rating.Again ? AGAIN_FEEDBACK_GRACE_MS : 0)).toISOString()
					: new Date(now.getTime() + intervalMs()).toISOString();
				setRuntimeState(db, {
					active_item_id: null,
					active_kind: null,
					active_direction: "forward",
					active_version: cur.active_version + 1,
					...EMPTY_SENTENCE_CYCLE,
					next_check_at: nextCheck,
					coordinator: cur.coordinator,
					coordinator_until: cur.coordinator_until,
					last_activity: cur.last_activity,
				});
				applied = true;
			}
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			console.error(`[pi-english-anki] Rate CAS failed: ${err}`);
		} finally {
			clearPendingLocals();
		}

		if (!applied) {
			// Another session rated first; just refresh.
			renderGlobalCard(ctx);
			return true;
		}
		recordRendered(getRuntimeState(db));
		const downgradeNote = effective === rating
			? ""
			: assistanceLevel === "revealed" ? "（翻了答案，按忘记安排）"
			: assistanceLevel === "hint" ? "（用了提示，按困难安排）"
			: "（自评兜底，按困难保守安排）";
		if (effective === Rating.Good) {
			updateWidget(ctx, FACES.review, [
				...(recallNote ? [recallNote] : []),
				`${FACES.review} 记牢了！下次 ${next.due.slice(0, 10)} 再见这个${TYPE_LABELS[item.type] ?? "学习项"}`,
				statsLine(db),
			]);
		} else if (effective === Rating.Hard) {
			updateWidget(ctx, FACES.review, [
				...(recallNote ? [recallNote] : []),
				`${FACES.review} 记了个大概${downgradeNote}，下次 ${next.due.slice(0, 10)} 再见这个${TYPE_LABELS[item.type] ?? "学习项"}`,
				statsLine(db),
			]);
		} else {
			const lines = [...(recallNote ? [recallNote] : []), `${FACES.error} 没关系${downgradeNote}，待会儿再考你一次 ${item.text}`];
			const mastery = db.prepare("SELECT consecutive_again FROM mastery_state WHERE item_id = ?").get(item.id) as { consecutive_again: number } | undefined;
			if (Number(mastery?.consecutive_again ?? 0) >= 2) {
				lines.push(`💪 反复忘了，仔细看：${item.example || item.text}${item.example_cn ? `（${item.example_cn}）` : ""}`);
			}
			lines.push(statsLine(db));
			updateWidget(ctx, FACES.error, lines);
		}
		// Anki-style queue: immediate only when another stored card is claimable.
		if (hasImmediateNext) scheduleTimer(0);
		else scheduleTimer();
		return true;
	}

	/** Atomically mark the pending card as well-known and enqueue its replacement. */
	function skipPending(ctx: ExtensionContext): ItemRow | undefined {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return undefined;
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return undefined;
		const now = new Date();
		const minDue = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString();
		// Skip claims the whole word is known: push out BOTH directions (P0-1).
		// Cloze has a single direction, so it skips like a sentence card.
		const usesDirection = item.type === "word" || item.type === "phrase";
		const perDirection: { direction: "forward" | "reverse"; state: string; due: string }[] = [];
		let singleNext: { state: string; due: string } | undefined;
		if (usesDirection) {
			for (const dir of ["forward", "reverse"] as const) {
				const raw = directionFsrsState(db, item.id, dir) ?? (item.fsrs_state || null);
				const st = scheduleNext(raw, now, Rating.Easy);
				if ("corrupt" in st) {
					quarantineCorruptFsrs(db, item.id, raw ?? "", st.error, now);
					clearPendingLocals();
					ctx.ui.notify(`该卡片 FSRS 数据损坏，已隔离。`, "warning");
					renderGlobalCard(ctx);
					return undefined;
				}
				perDirection.push({ direction: dir, state: st.state, due: st.due < minDue ? minDue : st.due });
			}
		} else {
			const next = scheduleNext(item.fsrs_state, now, Rating.Easy);
			if ("corrupt" in next) {
				quarantineCorruptFsrs(db, item.id, item.fsrs_state, next.error, now);
				clearPendingLocals();
				ctx.ui.notify(`该卡片 FSRS 数据损坏，已隔离。`, "warning");
				renderGlobalCard(ctx);
				return undefined;
			}
			singleNext = { state: next.state, due: next.due < minDue ? minDue : next.due };
		}
		let applied = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id !== item.id || cur.active_version !== localVersion) {
				db.exec("ROLLBACK");
				renderGlobalCard(ctx);
				clearPendingLocals();
				return undefined;
			}
			if (usesDirection) {
				for (const d of perDirection) advanceReviewDirectional(db, item.id, d.direction, d.state, d.due, item.reviews + 1, now);
				db.prepare("UPDATE items SET status = 'mastered' WHERE id = ?").run(item.id);
			} else {
				db.prepare("UPDATE items SET status = 'mastered', fsrs_state = ?, due_at = ? WHERE id = ?").run(
					singleNext!.state,
					singleNext!.due,
					item.id,
				);
			}
			bumpStat(db, "total_skipped", 1);
			enqueueReplacement(db, item.type);
			// Give this instance a short grace to generate the replacement without
			// another session surfacing a card in between.
			setRuntimeState(db, {
				active_item_id: null,
				active_kind: null,
				active_direction: "forward",
				active_version: cur.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				next_check_at: new Date(now.getTime() + REPLACEMENT_GRACE_MS).toISOString(),
				coordinator: myId,
				coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(),
				generation_token: null,
				generation_until: null,
				last_activity: now.toISOString(),
			});
			applied = true;
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			throw err;
		}

		clearPendingLocals();
		if (applied) {
			recordRendered(getRuntimeState(db));
			updateWidget(ctx, FACES.party, [
				`${FACES.party} 好，${item.text} 记作很熟的内容，正在补充同类型卡片…`,
				statsLine(db),
			]);
			return item;
		}
		return undefined;
	}

	async function generateReplacementAndInsert(
		ctx: ExtensionContext,
		requestedType: GeneratedItem["type"],
		skippedItem?: ItemRow,
	): Promise<boolean> {
		if (!db) return false;
		// Legacy sentence skips are fulfilled with cloze cards now.
		const type: GeneratedItem["type"] = requestedType === "sentence" ? "cloze" : requestedType;
		if (type !== requestedType) logGenStatus("replacement_mapped: sentence→cloze");
		let skipped = skippedItem ?? latestMasteredItem(db, requestedType);
		if (skipped && skipped.type === "sentence" && type === "cloze") skipped = { ...skipped, type: "cloze" };
		if (!skipped) {
			updateWidget(ctx, FACES.error, ["待补卡片缺少来源记录，请保留队列并稍后重试。", statsLine(db)]);
			logGenStatus("replacement_no_source");
			return false;
		}
		const conversation = buildConversation(ctx.sessionManager.getBranch());
		if (!conversation.trim()) {
			updateWidget(ctx, FACES.idle, ["等会话形成明确话题后，再补充同类型卡片…", statsLine(db)]);
			logGenStatus("replacement_empty_conversation");
			return false;
		}
		const rejectionKey = `${type}\n${conversation}`;
		if (rejectionKey === lastRejectedReplacementKey) {
			updateWidget(ctx, FACES.idle, ["还在等待足够信息，以补充同类型卡片…", statsLine(db)]);
			logGenStatus("replacement_cached_rejection");
			return false;
		}
		const generationToken = claimGeneration();
		if (!generationToken) return false;

		// One profile+budget snapshot per generation, after the generation claim and
		// before any LLM await; the same snapshot feeds the generator, fallback,
		// and critic so adaptive decisions stay consistent within this attempt.
		const adaptive: AdaptiveContext = (() => {
			const profile = computeLearnerProfile(db, new Date());
			return { profile, budget: deriveBudget(profile) };
		})();
		const replacementRecentLog = formatAttemptLogBlock(recentAttemptLog(db));

		const generation = sessionGeneration;
		pendingLLMCall = true;
		pendingLLMCallAt = Date.now();
		updateWidget(ctx, FACES.teach, ["正在补充同类型卡片，喵…"]);
		try {
			let effectiveResolved = resolveModel(ctx);
			if (!effectiveResolved) throw new Error("NO_MODEL");
			let decision: ReplacementDecision;
			try {
				decision = await generateReplacement(llm, ctx, effectiveResolved, conversation, replacementKnownList(db), config, skipped, adaptive, replacementRecentLog);
			} catch (err) {
				if (!effectiveResolved.fromSession && ctx.model &&
					(ctx.model.provider !== effectiveResolved.provider || ctx.model.id !== effectiveResolved.model)) {
					if (sessionGeneration !== generation || !db) return false;
					effectiveResolved = { provider: ctx.model.provider, model: ctx.model.id, fromSession: true };
					decision = await generateReplacement(
						llm,
						ctx,
						effectiveResolved,
						conversation,
						replacementKnownList(db),
						config,
						skipped,
						adaptive,
						replacementRecentLog,
					);
				} else {
					throw err;
				}
			}
			if (sessionGeneration !== generation || !db) return false;
			if (buildConversation(ctx.sessionManager.getBranch()) !== conversation) return false;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
			if (!decision.ready) {
				lastRejectedReplacementKey = rejectionKey;
				updateWidget(ctx, FACES.idle, ["还在等待足够信息，以补充同类型卡片…", statsLine(db)]);
				logGenStatus(`replacement_not_ready: ${decision.reason || ""}`);
				if (config.verbose && decision.reason) ctx.ui.notify(`暂不补卡：${decision.reason}`, "info");
				return false;
			}

			const item = decision.item;
			// Independent critic on replacement content (same fail-closed semantics as lessons).
			const replacementVerdict = await critiqueLesson(llm, ctx, effectiveResolved, { topic: "replacement", items: [item] }, db ? knownList(db) : [], config, adaptive);
			if (sessionGeneration !== generation || !db) return false;
			if (buildConversation(ctx.sessionManager.getBranch()) !== conversation) return false;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
			if (!replacementVerdict.pass) {
				if (replacementVerdict.available) lastRejectedReplacementKey = rejectionKey;
				updateWidget(ctx, FACES.idle, [
					replacementVerdict.available ? "补充卡内容质量未达标，保留队列稍后再试…" : "补充卡审查暂时不可用，保留队列稍后重试…",
					statsLine(db),
				]);
				logGenStatus(`${replacementVerdict.available ? "replacement_critic_rejected" : "replacement_critic_unavailable"}: ${replacementVerdict.summary || ""}`);
				if (config.verbose) ctx.ui.notify(`补充卡被审查拒绝：${replacementVerdict.summary}`, "info");
				return false;
			}

			const now = new Date();
			let inserted: ItemRow | undefined;
			let duplicate = false;
			db.exec("BEGIN IMMEDIATE");
			try {
				const state = getRuntimeState(db);
				const dueReview = db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 1 ${SCHEDULABLE} LIMIT 1`).get(now.toISOString());
				if (!ownsGeneration(state, generationToken, now) || state.active_item_id != null || pendingReplacementTypes(db)[0] !== requestedType || dueReview) {
					db.exec("ROLLBACK");
					logGenStatus("replacement_insert_deferred");
					return false;
				}
				const dupFp = contentFingerprint(item.type, item.text, item.meaning);
				const dup = db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(dupFp);
				if (dup) {
					duplicate = true;
					db.exec("ROLLBACK");
				} else {
					const id = insertItem(db, item.type, item.text, item.phonetic || null, item.meaning, item.example || null, item.example_cn || null, now, {
						levels: item.levels,
						levels_cn: item.levels_cn,
						chunks: item.chunks,
						keyWords: item.keyWords,
						introductionKind: "replacement",
					});
					bumpStat(db, "total_learned", 1);
					touchStreak(db, now);
					if (!consumeReplacement(db, requestedType)) throw new Error("REPLACEMENT_QUEUE_MISMATCH");
					markShown(db, id);
					db.prepare("UPDATE items SET introduced_at = ? WHERE id = ?").run(now.toISOString(), id);
					setRuntimeState(db, {
						active_item_id: id,
						active_kind: "teach",
						active_direction: "forward",
						active_version: state.active_version + 1,
						...EMPTY_SENTENCE_CYCLE,
						next_check_at: now.toISOString(),
						generation_token: null,
						generation_until: null,
					});
					inserted = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
					if (!inserted) throw new Error("REPLACEMENT_INSERT_FAILED");
					db.exec("COMMIT");
				}
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				throw err;
			}
			if (duplicate) {
				lastRejectedReplacementKey = rejectionKey;
				updateWidget(ctx, FACES.idle, ["模型给出了重复内容，等话题变化后再补卡…", statsLine(db)]);
				logGenStatus("replacement_duplicate");
				return false;
			}
			lastRejectedReplacementKey = "";
			if (!inserted) return false;
			logGenStatus(`replacement_ok: ${type} ${item.text}`);
			showItem(ctx, inserted);
			if (config.verbose) ctx.ui.notify(`已补充 ${TYPE_LABELS[type]}：${item.text}`, "info");
			return true;
		} catch (err) {
			if (sessionGeneration !== generation) return false;
			const msg = (err as Error)?.message || String(err);
			lastError = String((err as Error & { code?: string }).code || msg).slice(0, 80);
			if (db && !isCtxStale(ctx)) updateWidget(ctx, FACES.error, [`补卡失败：${lastError}`, statsLine(db)]);
			logGenStatus(`replacement_error: ${lastError}`);
			return false;
		} finally {
			if (db) releaseGeneration(generationToken);
			if (sessionGeneration === generation) {
				pendingLLMCall = false;
				pendingLLMCallAt = 0;
			}
		}
	}

	async function petTick(ctx: ExtensionContext) {
		const generation = sessionGeneration;
		if (isCtxStale(ctx)) return;
		if (!db) return;
		const now = new Date();
		const state0 = getRuntimeState(db);
		// A global card is active: render it and never swap it for another.
		if (state0.active_item_id != null) {
			renderGlobalCard(ctx);
			return;
		}

		// Respect the global pacing window so one session's rating cannot let
		// another session surface a different card ahead of the interval.
		if (!pacingReady(state0, now)) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
			return;
		}

		// Already-shown due reviews always win; never make them wait on replacement LLM work.
		const dueReview = claimDueItem(now, true);
		if (dueReview) {
			if (!showItem(ctx, dueReview)) renderGlobalCard(ctx);
			return;
		}

		// A skipped card reserves one same-type replacement after due reviews.
		const replacementType = pendingReplacementTypes(db)[0];
		let replacementWaiting = false;
		if (replacementType) {
			if (await generateReplacementAndInsert(ctx, replacementType)) return;
			if (sessionGeneration !== generation || !db) return;
			const state = getRuntimeState(db);
			const generationBusy = Boolean(
				state.generation_token && state.generation_until &&
				Date.now() < new Date(state.generation_until).getTime()
			);
			if (generationBusy) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
				return;
			}
			// Generation is waiting for better context; keep the FIFO obligation but
			// allow an already-due card to surface.
			resetPacing(db);
			replacementWaiting = true;
		}

		// 1. Due item first: select + mark + activate in one transaction.
		const due = claimDueItem(new Date());
		if (due) {
			if (!showItem(ctx, due)) renderGlobalCard(ctx);
			return;
		}
		if (getRuntimeState(db).active_item_id != null) {
			renderGlobalCard(ctx);
			return;
		}
		if (replacementWaiting) return;

		// 2. Otherwise teach new items (LLM), up to the daily limit (0 = unlimited), single-owner.
		if (config.dailyNewLimit === 0 || countTodayNew(db, now) < config.dailyNewLimit) {
			if (pendingLLMCall && !resetHungLlmCall()) return;
			await generateAndInsert(ctx, now);
			return;
		}

		// 3. Nothing to do: the pet dozes off
		if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
	}

	function logGenStatus(status: string) {
		if (!db) return;
		setStat(db, "last_gen_status", status.slice(0, 200));
		// Progress markers are not decisions; the ring log records outcomes only.
		if (!status.startsWith("model:")) appendGenLog(db, status);
	}
	function deferPacing() {
		if (db) setRuntimeState(db, { next_check_at: new Date(Date.now() + Math.max(1, config.intervalMinutes) * 60_000).toISOString() });
	}

	async function generateAndInsert(ctx: ExtensionContext, _now: Date) {
		const conversationSnapshot = buildConversation(ctx.sessionManager.getBranch());
		const conversation = manualTeachTopic || conversationSnapshot;
		const isManual = manualTeachTopic !== "";
		manualTeachTopic = "";
		const conversationUnchanged = () => buildConversation(ctx.sessionManager.getBranch()) === conversationSnapshot;
		if (!conversation.trim()) {
			if (db) updateWidget(ctx, FACES.idle, [statsLine(db)]);
			logGenStatus("empty_conversation");
			deferPacing();
			return;
		}
		if (!isManual && conversation === lastRejectedConversation) {
			if (db) updateWidget(ctx, FACES.idle, ["还在观察话题，等信息更完整些…", statsLine(db)]);
			logGenStatus("cached_rejection");
			deferPacing();
			return;
		}
		const generationToken = claimGeneration();
		if (!generationToken) { logGenStatus("no_gen_token"); return; }

		// One profile+budget snapshot per generation, after the generation claim and
		// before any LLM await; the same snapshot feeds the initial generator,
		// fallback, revisions, and critic so adaptive decisions stay consistent.
		const adaptive: AdaptiveContext | null = db ? (() => {
			const profile = computeLearnerProfile(db, new Date());
			return { profile, budget: smoothBudget(db, deriveBudget(profile)) };
		})() : null;
		const recentLog = db ? formatAttemptLogBlock(recentAttemptLog(db)) : undefined;

		const generation = sessionGeneration;
		pendingLLMCall = true;
		pendingLLMCallAt = Date.now();
		if (db) updateWidget(ctx, FACES.teach, ["备课中，喵…"]);
		try {
			let effectiveResolved = resolveModel(ctx);
			if (!effectiveResolved) throw new Error("NO_MODEL");
			logGenStatus(`model:${resolvedModelName}`);
			let decision: LessonDecision;
			try {
				decision = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? knownList(db) : [], config, undefined, adaptive ?? undefined, recentLog);
			} catch (err) {
				if (sessionGeneration !== generation) return;
				if (!effectiveResolved.fromSession && ctx.model &&
					(ctx.model.provider !== effectiveResolved.provider || ctx.model.id !== effectiveResolved.model)) {
					effectiveResolved = {
						provider: ctx.model.provider,
						model: ctx.model.id,
						fromSession: true,
					};
					decision = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? knownList(db) : [], config, undefined, adaptive ?? undefined, recentLog);
					if (sessionGeneration !== generation) return;
					resolvedModelName = `${effectiveResolved.provider}/${effectiveResolved.model}（当前会话·降级）`;
				} else {
					throw err;
				}
			}
			if (sessionGeneration !== generation || !db || !conversationUnchanged()) return;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return;
			if (!decision.ready) {
				lastRejectedConversation = conversation;
				updateWidget(ctx, FACES.idle, ["还在观察话题，等信息更完整些…", statsLine(db)]);
				logGenStatus(`not_ready: ${decision.reason || ""}`);
				deferPacing();
				if (config.verbose && decision.reason) ctx.ui.notify(`暂不备课：${decision.reason}`, "info");
				return;
			}

			let lesson = decision;
			// Quality gate: an independent critic must approve the generated content.
			let verdict = await critiqueLesson(llm, ctx, effectiveResolved, lesson, db ? knownList(db) : [], config, adaptive ?? undefined);
			if (sessionGeneration !== generation) return;
			if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
			// Revision loop: address critic feedback before giving up.
			for (let attempt = 0; attempt < MAX_LESSON_REVISIONS && verdict.available && !verdict.pass; attempt++) {
				const revised = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? knownList(db) : [], config, verdict.issues, adaptive ?? undefined, recentLog);
				if (sessionGeneration !== generation) return;
				if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
				if (!revised.ready) break;
				lesson = revised;
				verdict = await critiqueLesson(llm, ctx, effectiveResolved, lesson, db ? knownList(db) : [], config, adaptive ?? undefined);
				if (sessionGeneration !== generation) return;
				if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
			}
			if (!verdict.pass) {
				if (verdict.available) lastRejectedConversation = conversation;
				updateWidget(ctx, FACES.idle, [
					verdict.available ? "内容质量未达标，稍后再试…" : "内容审查暂时不可用，稍后重试…",
					statsLine(db),
				]);
				logGenStatus(`${verdict.available ? "critic_rejected" : "critic_unavailable"}: ${verdict.summary || ""}`);
				deferPacing();
				if (config.verbose) ctx.ui.notify(`备课被审查拒绝：${verdict.summary}`, "info");
				return;
			}
			if (!conversationUnchanged()) return;
			const insertedAt = new Date();
			let insertedFirst: ItemRow | undefined;
			db.exec("BEGIN IMMEDIATE");
			try {
				const state = getRuntimeState(db);
				if (!ownsGeneration(state, generationToken, insertedAt) ||
					state.active_item_id != null ||
					(config.dailyNewLimit > 0 && countTodayNew(db, insertedAt) >= config.dailyNewLimit) ||
					pendingReplacementTypes(db).length > 0 ||
					getDueItem(db, insertedAt)) {
					db.exec("ROLLBACK");
					logGenStatus("insert_deferred");
					return;
				}
				// Reject the whole batch if any item duplicates an existing canonical item.
				for (const it of lesson.items) {
					const fp = contentFingerprint(it.type, it.text, it.meaning);
					if (db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(fp)) {
						db.exec("ROLLBACK");
						logGenStatus(`duplicate_batch: ${it.type} ${it.text}`);
						return;
					}
				}
				let firstId: number | undefined;
				for (const it of lesson.items) {
					const id = insertItem(db, it.type, it.text, it.phonetic || null, it.meaning, it.example || null, it.example_cn || null, insertedAt, {
						levels: it.levels,
						levels_cn: it.levels_cn,
						chunks: it.chunks,
						keyWords: it.keyWords,
					});
					firstId ??= id;
				}
				if (firstId == null) throw new Error("LESSON_INSERT_FAILED");
				bumpStat(db, "total_learned", 1);
				touchStreak(db, insertedAt);
				markShown(db, firstId);
				db.prepare("UPDATE items SET introduced_at = ? WHERE id = ?").run(insertedAt.toISOString(), firstId);
				setRuntimeState(db, {
					active_item_id: firstId,
					active_kind: "teach",
					active_direction: "forward",
					active_version: state.active_version + 1,
					...EMPTY_SENTENCE_CYCLE,
					next_check_at: insertedAt.toISOString(),
					generation_token: null,
					generation_until: null,
				});
				insertedFirst = db.prepare("SELECT * FROM items WHERE id = ?").get(firstId) as ItemRow | undefined;
				db.exec("COMMIT");
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				throw err;
			}
			lastRejectedConversation = "";
			logGenStatus(`ok: ${lesson.topic || ""}`);
			if (!insertedFirst) return;
			showItem(ctx, insertedFirst);
			if (lesson.topic && db) {
				updateWidget(ctx, FACES.teach, [
					`${FACES.teach} 今日主题：${lesson.topic}`,
					...renderCard(insertedFirst, false, FACES.teach, false),
					statsLine(db),
				]);
			}
			if (config.verbose) {
				ctx.ui.notify(`备好课啦：${lesson.topic || "主题"}，共 ${lesson.items.length} 个学习项`, "info");
			}
		} catch (err) {
			if (sessionGeneration !== generation) return;
			const msg = (err as Error)?.message || String(err);
			lastError = String((err as Error & { code?: string }).code || msg).slice(0, 80);
			if (db) updateWidget(ctx, FACES.error, [`备课失败：${lastError}`, statsLine(db)]);
			logGenStatus(`error: ${lastError}`);
			deferPacing();
		} finally {
			if (db) releaseGeneration(generationToken);
			if (sessionGeneration === generation) {
				pendingLLMCall = false;
				pendingLLMCallAt = 0;
			}
		}
	}

	async function runSkipAction(ctx: ExtensionContext): Promise<void> {
		if (!db) {
			ctx.ui.notify("当前没有可跳过的卡片", "info");
			return;
		}
		const queueWasEmpty = pendingReplacementTypes(db).length === 0;
		let skipped: ItemRow | undefined;
		try {
			skipped = skipPending(ctx);
		} catch (err) {
			ctx.ui.notify(`标记失败：${(err as Error).message}`, "error");
			return;
		}
		if (!skipped || !db) {
			ctx.ui.notify("当前没有可跳过的卡片", "info");
			return;
		}
		// A due review must never wait for replacement generation.
		resetPacing(db);
		const dueReview = claimDueItem(new Date(), true);
		if (dueReview) {
			if (!showItem(ctx, dueReview)) renderGlobalCard(ctx);
			return;
		}
		const nextType = pendingReplacementTypes(db)[0];
		const source = queueWasEmpty && nextType === skipped.type ? skipped : undefined;
		const generation = sessionGeneration;
		const inserted = nextType ? await generateReplacementAndInsert(ctx, nextType, source) : false;
		if (sessionGeneration !== generation) return;
		if (!inserted && db) {
			// Generation failed or was waiting for info: lower the pacing window so
			// the next tick can surface a due card instead of stalling on the grace gap.
			resetPacing(db);
			scheduleTimer();
		}
	}

	// -- Commands ---------------------------------------------------------

	/** Authenticated, selectable models (ordered by auto-detect priority). */
	function selectableModels(ctx: ExtensionContext) {
		const available = ctx.modelRegistry.getAvailable();
		const withAuth = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
		return withAuth.sort((a, b) => {
			const ia = AUTO_DETECT_MODELS.indexOf(a.id);
			const ib = AUTO_DETECT_MODELS.indexOf(b.id);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});
	}

	/** Merge a patch into the global config file, keeping other keys. */
	function persistConfig(patch: Record<string, unknown>) {
		const globalPath = join(getAgentDir(), "kaomoji-english-tutor.json");
		try {
			const existing = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, "utf-8")) : {};
			writeFileSync(globalPath, JSON.stringify({ ...existing, ...patch }, null, 2) + "\n");
		} catch (err) {
			console.error(`[pi-english-anki] Failed to persist config: ${err}`);
		}
	}

	function applyLessonModel(ctx: ExtensionContext, spec: string) {
		const [provider, model] = spec.split("/", 2);
		if (!provider || !model) {
			ctx.ui.notify(`无效的模型格式：${spec}（应为 provider/model）`, "error");
			return false;
		}
		const found = ctx.modelRegistry.find(provider, model);
		if (!found || !ctx.modelRegistry.hasConfiguredAuth(found)) {
			ctx.ui.notify(`模型不可用或未配置密钥：${spec}`, "error");
			return false;
		}
		config.provider = provider;
		config.model = model;
		resolvedModelName = `${provider}/${model}`;
		persistConfig({ provider, model });
		ctx.ui.notify(`备课模型已设为 ${spec}（已保存，立即生效）`, "info");
		return true;
	}

	pi.registerCommand("anki:model", {
		description: "Show/set the lesson model: pick from authenticated models or pass provider/model",
		handler: async (args, ctx) => {
			const target = String(args ?? "").trim();
			const models = selectableModels(ctx);

			// Show current model first
			if (!resolvedModelName) resolveModel(ctx);
			ctx.ui.notify(`当前备课模型：${resolvedModelName || "（未确定）"}`, "info");

			if (!models.length) {
				ctx.ui.notify("没有已认证的可用模型", "error");
				return;
			}

			// Bare invocation: interactive picker
			if (!target) {
				const options = models.map((m, i) => `${i + 1}. ${m.provider}/${m.id}`);
				const chosen = await ctx.ui.select("选择备课模型", options);
				if (!chosen) {
					ctx.ui.notify("已取消", "info");
					return;
				}
				const idx = parseInt(chosen.split(".")[0], 10) - 1;
				const picked = models[idx];
				if (picked) applyLessonModel(ctx, `${picked.provider}/${picked.id}`);
				return;
			}

			// Number: index into the listed models
			if (/^\d+$/.test(target)) {
				const idx = parseInt(target, 10) - 1;
				if (idx < 0 || idx >= models.length) {
					ctx.ui.notify(`编号无效（1-${models.length}）`, "error");
					return;
				}
				const picked = models[idx];
				applyLessonModel(ctx, `${picked.provider}/${picked.id}`);
				return;
			}

			// provider/model form
			if (target.includes("/")) {
				applyLessonModel(ctx, target);
				return;
			}

			ctx.ui.notify(`用法：/anki:model（交互选择）或 /anki:model <provider/model|编号>`, "info");
		},
	});

	pi.registerCommand("anki:interval", {
		description: "Show/set the automatic lesson interval in minutes, or off",
		handler: async (args, ctx) => {
			const target = String(args ?? "").trim().toLowerCase();
			if (!target) {
				ctx.ui.notify(
					config.intervalMinutes > 0 ? `当前自动检查间隔：${config.intervalMinutes} 分钟` : "自动检查已关闭",
					"info",
				);
				ctx.ui.notify("用法：/anki:interval <分钟|off>", "info");
				return;
			}
			if (target === "off") {
				config.intervalMinutes = 0;
				persistConfig({ intervalMinutes: 0 });
				stopTimer();
				ctx.ui.notify("自动检查已关闭", "info");
				return;
			}
			const minutes = Number(target);
			if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
				ctx.ui.notify("请输入大于 0 且不超过 1440 的分钟数，或 off", "error");
				return;
			}
			config.intervalMinutes = minutes;
			persistConfig({ intervalMinutes: minutes });
			scheduleTimer();
			ctx.ui.notify(`自动检查间隔已设为 ${minutes} 分钟（立即生效）`, "info");
		},
	});

	pi.registerCommand("anki:thinking", {
		description: "Show/set the lesson thinking level (off|minimal|low|medium|high|xhigh|max)",
		handler: async (args, ctx) => {
			const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const target = String(args ?? "").trim().toLowerCase();
			if (!target) {
				ctx.ui.notify(`当前备课思考等级：${config.thinkingLevel ?? "（provider 默认）"}`, "info");
				ctx.ui.notify(`用法：/anki:thinking <${LEVELS.join("|")}>`, "info");
				return;
			}
			if (!(LEVELS as readonly string[]).includes(target)) {
				ctx.ui.notify(`无效等级：${target}（可选 ${LEVELS.join(" | ")}）`, "error");
				return;
			}
			config.thinkingLevel = target as ThinkingLevel;
			persistConfig({ thinkingLevel: target });
			ctx.ui.notify(`备课思考等级已设为 ${target}（已保存，立即生效）`, "info");
		},
	});

	pi.registerCommand("anki:flip", {
		description: "Toggle the shown card between question and answer sides",
		handler: async (_args, ctx) => {
			if (!flipPending(ctx)) {
				ctx.ui.notify("当前没有可翻面的卡片", "info");
			}
		},
	});

	pi.registerCommand("anki:good", {
		description: "Rate a word/phrase as remembered; sentences require /anki:answer",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Good)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("anki:again", {
		description: "Rate the pending review card as forgotten (FSRS Again)",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Again)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("anki:skip", {
		description: "Mark the shown card as known and generate a same-type replacement",
		handler: async (_args, ctx) => {
			await runSkipAction(ctx);
		},
	});

	pi.registerCommand("anki:answer", {
		description: "Submit bidirectional recall or progressive written sentence output",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			const ok = await answerPending(ctx, text);
			if (!ok && !text) {
				ctx.ui.notify("用法：/anki:answer <你的答案>（无参数显示题目）", "info");
			}
		},
	});

	pi.registerCommand("anki:hint", {
		description: "Show a recall hint or the current sentence level's initial-letter hint",
		handler: async (_args, ctx) => {
			if (!hintPending(ctx)) ctx.ui.notify("当前没有可提示的词卡", "info");
		},
	});

	pi.registerCommand("anki:teach", {
		description: "Prepare a lesson on a specific topic now (bypasses readiness detection)",
		handler: async (args, ctx) => {
			const topic = String(args ?? "").trim();
			if (!topic) {
				ctx.ui.notify("用法：/anki:teach <话题>（例如 /anki:teach async programming）", "info");
				return;
			}
			manualTeachTopic = topic;
			ctx.ui.notify(`将围绕「${topic}」备课`, "info");
			if (pendingLLMCall) {
				ctx.ui.notify("上一轮备课还在进行中，请稍候", "info");
				return;
			}
			void generateAndInsert(ctx, new Date())
				.catch((err) => console.error(`[pi-english-anki] teach failed: ${err}`))
				.finally(() => scheduleTimer());
		},
	});

	pi.registerCommand("anki:stats", {
		description: "Show detailed learning statistics (mastery stages, reinforcement, answer accuracy)",
		handler: async (_args, ctx) => {
			if (!db) return;
			const stages = db.prepare("SELECT stage, COUNT(*) AS n FROM mastery_state GROUP BY stage ORDER BY stage").all() as { stage: string; n: number }[];
			const reinforce = Number((db.prepare("SELECT COUNT(*) AS n FROM mastery_state WHERE consecutive_again >= 2").get() as { n: number }).n);
			const attempts = Number((db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n);
			const correct = Number((db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE verdict = 'correct'").get() as { n: number }).n);
			const rate = attempts > 0 ? Math.round((correct / attempts) * 100) : 0;
			const stageLine = stages.length ? stages.map((s) => `${s.stage}:${s.n}`).join(" · ") : "暂无";
			ctx.ui.notify(`掌握阶段：${stageLine}；需强化：${reinforce}；答题 ${attempts} 次，正确率 ${rate}%`, "info");
			const profile = computeLearnerProfile(db, new Date());
			ctx.ui.notify(formatProfileStatsLine(profile, deriveBudget(profile)), "info");
			const genEvents = getGenLog(db).slice(-3);
			if (genEvents.length) {
				const fmt = (t: string) => {
					const d = new Date(t);
					const pad = (n: number) => String(n).padStart(2, "0");
					return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
				};
				ctx.ui.notify(`最近备课决策：${genEvents.map((e) => `${fmt(e.t)} ${e.s}`).join("；")}`, "info");
			}
		},
	});

	pi.registerCommand("anki:pull", {
		description: "从云端拉取更新的学习数据（本地旧库备份为 .bak）",
		handler: async (_args, ctx) => {
			if (!isSyncEnabled()) { ctx.ui.notify("未配置同步仓库：~/.pi/agent/kaomoji-english-tutor-sync", "warning"); return; }
			if (answerJudging || pendingLLMCall) { ctx.ui.notify("正在判题/备课，稍后再拉取", "warning"); return; }
			const generation = sessionGeneration;
			stopAnswerThinking();
			stopTimer();
			stopPolling();
			releaseCoordinator();
			if (db) {
				// Unregister myself so the live-client guard does not refuse the swap.
				try { db.prepare("DELETE FROM runtime_clients WHERE client_id = ?").run(myId); } catch { /* best effort */ }
			}
			clearPendingLocals();
			localVersion = -1;
			closeDb();
			const r = await pullIfNewer(dbFilePath(), { force: true });
			if (generation !== sessionGeneration) return; // a newer session_start owns the DB now
			try {
				db = openDb();
			} catch (err) {
				console.error(`[pi-english-anki] Failed to reopen DB after pull: ${err}`);
				db = null;
			}
			if (db && (r.status === "pulled" || r.status === "error")) {
				appendGenLog(db, r.status === "pulled"
					? `sync_pulled: ${r.remoteTs}`
					: `sync_pull_error: ${r.message ?? ""}`);
			}
			attachDb(ctx);
			scheduleTimer();
			if (r.status === "pulled") ctx.ui.notify("已从云端拉取最新学习数据 ✓（旧本地库已备份 .bak）", "info");
			else if (r.status === "current") ctx.ui.notify("本地已是最新，无需拉取", "info");
			else if (r.status === "no_remote") ctx.ui.notify("远端还没有可拉取的快照", "warning");
			else if (r.status !== "disabled") ctx.ui.notify(`拉取失败：${r.message ?? r.status}`, "error");
		},
	});

	pi.registerCommand("anki:sync", {
		description: "立即将学习数据推送到云端同步仓库",
		handler: async (_args, ctx) => {
			if (!db) { ctx.ui.notify("数据库不可用", "error"); return; }
			if (!isSyncEnabled()) { ctx.ui.notify("未配置同步仓库：~/.pi/agent/kaomoji-english-tutor-sync", "warning"); return; }
			const r = await pushSnapshot(db, { ignoreThrottle: true });
			if (r.status === "pushed") ctx.ui.notify("学习数据已推送到云端 ✓", "info");
			else if (r.status === "unchanged") ctx.ui.notify("没有需要推送的新进度", "info");
			else if (r.status === "remote_newer") ctx.ui.notify("云端有更新的进度，执行 /anki:pull 拉取（本地旧库会备份 .bak）", "warning");
			else ctx.ui.notify(`同步失败：${r.message ?? r.status}`, "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration++;
		stopAnswerThinking();
		stopTimer();
		lastDataVersion = null;
		localVersion = -1;
		releaseCoordinator();
		closeDb();
		config = loadConfig(ctx.cwd);
		resetState();
		latestCtx = ctx;
		// Establish my coordinator identity for the shared generation lease.
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
		} catch {
			sessionId = "";
		}
		myId = myCoordinatorId(sessionId, instanceToken);
		clearPendingLocals();
		// Cloud sync never blocks startup: no network here. A background peek
		// runs after attach and nudges toward /anki:pull when the cloud is newer.
		try {
			db = openDb();
		} catch (err) {
			console.error(`[pi-english-anki] Failed to open DB: ${err}`);
			db = null;
		}
		attachDb(ctx);
		scheduleTimer();
		const generation = sessionGeneration;
		void peekRemoteNewer().then((r) => {
			if (generation !== sessionGeneration || !latestCtx || isCtxStale(latestCtx)) return;
			if (r.remoteNewer) latestCtx.ui.notify("云端有更新的学习进度，执行 /anki:pull 拉取（本地旧库会备份 .bak）", "warning");
		}, () => { /* peek must never surface errors */ });
	});

	pi.on("session_shutdown", async () => {
		sessionGeneration++;
		stopAnswerThinking();
		await llm.dispose();
		stopTimer();
		stopPolling();
		releaseCoordinator();
		latestCtx = undefined;
		clearPendingLocals();
		pendingLLMCall = false;
		pendingLLMCallAt = 0;
		sessionId = "";
		myId = "";
		lastCoordinatorRenewal = 0;
		lastDataVersion = null;
		localVersion = -1;
		// Cloud sync: best-effort final push so a machine switch picks up this progress.
		if (db) {
			try {
				await pushSnapshot(db, { ignoreThrottle: true });
			} catch { /* shutdown must not fail on sync */ }
		}
		closeDb();
	});

	// Real user activity makes this the most-recent coordinator; injected input does not.
	pi.on("input", (event, _ctx) => {
		if (event.source !== "extension") ensureCoordinator(new Date(), true);
		return { action: "continue" };
	});
}
