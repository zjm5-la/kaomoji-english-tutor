import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LESSON_CLOZE_ITEMS, LESSON_MAX_PHRASES, LESSON_WORD_ITEMS, type PetConfig } from "./config.ts";
import type { PiSdkLlmClient } from "./pi-sdk-llm.ts";
import type { ItemRow } from "./db.ts";
import type { SentenceExerciseView } from "./render.ts";
import { coldStartProfile, deriveBudget, formatAdaptiveBlock, normalizeErrorTag, type AdaptiveContext } from "./learner-profile.ts";

// -- LLM lesson generation ------------------------------------------------

export interface GeneratedItem {
	type: "word" | "phrase" | "sentence" | "cloze";
	text: string;
	phonetic?: string;
	meaning: string;
	example?: string;
	example_cn?: string;
	/** Sentence only: 3 progressive levels (main clause -> full sentence). */
	levels?: string[];
	/** Sentence only: per-level Chinese translations, aligned with levels. */
	levels_cn?: string[];
	/** Sentence/cloze only: chunking of the full sentence for guided reading. */
	chunks?: string[];
	/** Sentence only: likely-new words inside the sentence, with meanings. */
	keyWords?: { text: string; phonetic?: string; meaning: string }[];
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) return undefined;
	return value;
}

function keyWordArray(value: unknown): GeneratedItem["keyWords"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: NonNullable<GeneratedItem["keyWords"]> = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const record = entry as Record<string, unknown>;
		if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) {
			return undefined;
		}
		if (record.phonetic != null && typeof record.phonetic !== "string") return undefined;
		result.push({ text: record.text, meaning: record.meaning, phonetic: record.phonetic as string | undefined });
	}
	return result;
}

function clozeTextAppendsAnswer(text: string, answer: string): boolean {
	const suffix = text.match(/\s(?:=|→)\s*(.+?)\s*$/u)?.[1];
	if (!suffix) return false;
	const normalize = (value: string) => value.trim().replace(/[.!?。！？]+$/u, "").trim().toLowerCase().replace(/\s+/g, " ");
	return normalize(suffix) === normalize(answer);
}

/** Extract the first JSON object, tolerating an optional Markdown fence. */
function extractJsonObjectText(text: string): string | undefined {
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	return start >= 0 && end > start ? cleaned.slice(start, end + 1) : undefined;
}

function parseGeneratedItem(raw: unknown, expectedType?: GeneratedItem["type"]): GeneratedItem | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const type = record.type;
	if (type !== "word" && type !== "phrase" && type !== "sentence" && type !== "cloze") return undefined;
	if (expectedType && type !== expectedType) return undefined;
	if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) return undefined;
	// Cloze: exactly one blank, non-empty answer (meaning checked above), and
	// 2-6 meaning chunks covering the full sentence (answer-face reading aid).
	let clozeChunks: string[] | undefined;
	if (type === "cloze") {
		if (record.text.split("___").length !== 2 || clozeTextAppendsAnswer(record.text, record.meaning)) return undefined;
		const chunks = stringArray(record.chunks);
		if (!chunks || chunks.length < 2 || chunks.length > 6) return undefined;
		clozeChunks = chunks;
	}
	for (const key of ["phonetic", "example", "example_cn"] as const) {
		if (record[key] != null && typeof record[key] !== "string") return undefined;
	}
	const item: GeneratedItem = {
		type,
		text: record.text,
		meaning: record.meaning,
		phonetic: record.phonetic as string | undefined,
		example: record.example as string | undefined,
		example_cn: record.example_cn as string | undefined,
		...(clozeChunks ? { chunks: clozeChunks } : {}),
	};
	if (type === "sentence") {
		if (record.levels != null && !(item.levels = stringArray(record.levels))) return undefined;
		if (record.levels_cn != null && !(item.levels_cn = stringArray(record.levels_cn))) return undefined;
		if (record.chunks != null && !(item.chunks = stringArray(record.chunks))) return undefined;
		if (record.keyWords != null && !(item.keyWords = keyWordArray(record.keyWords))) return undefined;
	}
	return item;
}

function validClozeItem(item: GeneratedItem): boolean {
	return item.type === "cloze" && item.text.split("___").length === 2 && Boolean(item.meaning.trim())
		&& !clozeTextAppendsAnswer(item.text, item.meaning)
		&& Array.isArray(item.chunks) && item.chunks.length >= 2 && item.chunks.length <= 6;
}

interface ReadyLesson {
	ready: true;
	topic: string;
	items: GeneratedItem[];
}

interface WaitingLesson {
	ready: false;
	reason?: string;
}

export type LessonDecision = ReadyLesson | WaitingLesson;

interface ReadyReplacement {
	ready: true;
	item: GeneratedItem;
}

export type ReplacementDecision = ReadyReplacement | WaitingLesson;

interface ResolvedModel {
	provider: string;
	model: string;
	fromSession: boolean;
}

/** Max critic-driven revision rounds before a lesson is discarded. */
export const MAX_LESSON_REVISIONS = 2;

/** Same-model retries for transient replacement output-shape errors (BAD_JSON etc.). */
export const REPLACEMENT_SHAPE_RETRIES = 1;

/** Transient model-output shape errors worth an immediate blind retry. */
function isTransientShapeError(err: unknown): boolean {
	const code = String((err as Error & { code?: string })?.code || (err as Error)?.message || "");
	return code === "BAD_JSON" || code === "INVALID_READY" || code === "EMPTY_REPLACEMENT";
}

export async function generateLesson(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
	feedback?: CritiqueIssue[],
	adaptive?: AdaptiveContext,
	recentLog?: string,
): Promise<LessonDecision> {
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;
	const prompt = [
		"你是「英语小宠物」的备课大脑。先判断下面的会话是否已经形成值得学习的明确主题。",
		"如果信息不足，只输出：{\"ready\":false,\"reason\":\"简短原因\"}。不要为了完成任务硬凑学习卡。",
		"只有信息充分时，才围绕主题准备一整天的课量：共 " + (LESSON_WORD_ITEMS + LESSON_CLOZE_ITEMS) + " 个学习项，其中 " + LESSON_WORD_ITEMS + " 个单词或词组（以单词为主，词组不超过 " + LESSON_MAX_PHRASES + " 个），" + (LESSON_CLOZE_ITEMS > 1 ? LESSON_CLOZE_ITEMS + " 个语法填空" : "1 个语法填空") + "。",
		"",
		"备课条件：",
		"- 只要会话中出现过真实、常用的英语表达（单词、词组、完整句子），就可以备课",
		"- 技术开发、工具使用、报错排查、代码评审都是有效话题，提取其中值得当前学习者掌握的英语",
		"- 只有纯寒暄、单字命令、无意义占位或环境通知才返回 ready=false",
		"- 有英语内容就倾向 ready=true，不要因为话题不够像传统英语课而拒绝",
		"",
		"学习项要求：",
		"- 内容要真实常用，贴近主题的实际使用场景，难度须贴合下面的画像与预算",
		"- word 和 phrase 的例句短小自然，贴近主题的实际使用场景",
		"- 教学项围绕同一主题：cloze 的句子可以自然复用本批次中 1-2 个刚教的单词或词组，形成一个统一的教学单元",
		`- 每个学习项必须互不重复；${LESSON_WORD_ITEMS} 个单词/词组项彼此独立，各自配一个小巧自然的例句`,
		"- cloze 是语法填空：一句英文恰好挖一个空（用 ___ 表示），空格后用括号给出所填词的原形提示，如 The fix that ___ (commit) this morning won't take effect.",
		"- cloze 的考点必须是明确的语法点（时态、语态、主谓一致、单复数、介词、冠词、非谓语、词形变化等），答案唯一且为最小形式",
		"- cloze 的句子必须在语法上锁死唯一答案：若同一个空存在多种语法正确的填法（如 isn't called 与 won't be called 都成立），必须加时间/语境锚点（如 once the migration finishes）排除歧义，否则换考点或改写句子",
		"- cloze 的 meaning 填正确答案（如 was committed）；text 只放挖空句，严禁在句尾附加 = was committed、→ was committed 等答案；example 填把答案代入后的完整正确句子；example_cn 填整句中文翻译，可附一句考点说明",
		`- cloze 的句子词数必须在 ${budget.wordRange[0]}-${budget.wordRange[1]} 之间，句法结构遵循预算的句法约束（见下方 difficulty_budget），句子必须真实自然`,
		"- word/phrase 的 meaning 只写可直接回忆的最小中文释义（直接翻译）；用途、效果等补充说明写进 example/example_cn，不得混入 meaning（反例：「重新加载，使新改动生效」应拆为 meaning「重新加载」，作用说明放例句）；释义只给一个首选说法，不并列近义改写（应写「生效」而非「生效，起作用」），确有多个义项才用「；」并列",
		'- 只输出 JSON，不要任何其他文字：',
		`{"ready":true,"topic":"主题名","items":[${Array.from({ length: LESSON_WORD_ITEMS }, () => '{"type":"word|phrase","text":"单词或词组","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"}').join(",")}${Array.from({ length: LESSON_CLOZE_ITEMS }, () => ',{"type":"cloze","text":"含一个 ___ 的英文句子（空后括号给原形提示）","phonetic":"","meaning":"正确答案","example":"代入答案后的完整句子","example_cn":"整句中文翻译（可附考点说明）","chunks":["意群1","意群2","意群3"]}').join("")}]}`,
		"- cloze 必须带 chunks（2-6 个意群，按顺序拼接后覆盖代入答案后的完整句子）",
		"- 不要与已学内容重复，也要避开相同句型：" + (known.length ? known.join("、") : "（暂无已学内容）"),
		...(feedback && feedback.length
			? ["", "上一次备课被审查拒绝，请针对以下问题改进（不要原样重复被拒内容）：",
				...feedback.map((i) => `- [${i.severity}] ${i.category}: ${i.description}`)]
			: []),
		...(recentLog
			? ["", "最近出题与作答记录（新→旧，含题目快照与判定反馈）：", recentLog,
				"参考记录：学生近期答错的内容可换角度复现巩固；若反馈指向出题方式本身（如释义混入补充说明），避免同类出题。"]
			: []),
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const text = await llm.complete(ctx, resolved, {
		systemPrompt: "你是英语小宠物的备课助手，只输出 JSON；信息不足时宁可等待。",
		prompt,
		maxTokens: config.maxTokens,
		thinkingLevel: config.thinkingLevel,
	});

	const json = extractJsonObjectText(text);
	if (!json) throw new Error("BAD_JSON");

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("BAD_JSON");
	}

	if (parsed.ready === false) {
		return {
			ready: false,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");

	if (!Array.isArray(parsed.items) || parsed.items.length !== LESSON_WORD_ITEMS + LESSON_CLOZE_ITEMS) throw new Error("INVALID_LESSON_SHAPE");
	const parsedItems = parsed.items.map((item) => parseGeneratedItem(item));
	if (parsedItems.some((item) => item == null)) throw new Error("INVALID_LESSON_ITEM");
	const items = parsedItems as GeneratedItem[];
	// The word/phrase slots are homogeneous now: at least one word, phrases capped,
	// sentence cards are legacy review-only.
	const wordCount = items.filter((item) => item.type === "word").length;
	const phraseCount = items.filter((item) => item.type === "phrase").length;
	const clozeCount = items.filter((item) => item.type === "cloze").length;
	if (wordCount + phraseCount !== LESSON_WORD_ITEMS || phraseCount > LESSON_MAX_PHRASES || wordCount < 1) throw new Error("INVALID_LESSON_SHAPE");
	if (clozeCount !== LESSON_CLOZE_ITEMS) throw new Error("INVALID_LESSON_SHAPE");
	// Grammar clozes are the dedicated slots now; sentences are legacy review-only.
	if (items.some((item) => item.type === "sentence")) throw new Error("INVALID_LESSON_SHAPE");
	if (items.filter((item) => item.type === "cloze").some((item) => !validClozeItem(item))) throw new Error("INVALID_LESSON_ITEM");
	// Reject in-batch duplicates early; the fingerprint unique index would
	// otherwise sink the whole commit at insertion time.
	const batchTexts = new Set(items.map((item) => item.text.trim().toLowerCase()));
	if (batchTexts.size !== items.length) throw new Error("INVALID_LESSON_ITEM");

	return { ready: true, topic: String(parsed.topic ?? ""), items };
}

interface CritiqueIssue {
	severity: "blocker" | "minor";
	category: string;
	description: string;
}

interface CritiqueVerdict {
	available: boolean;
	pass: boolean;
	issues: CritiqueIssue[];
	summary: string;
}

/**
 * Independent quality gate. Fail-closed on model/auth/runtime/bad-JSON errors
 * so a broken critic defers insertion rather than approving unreviewed content.
 */
export async function critiqueLesson(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	lesson: { topic: string; items: GeneratedItem[] },
	known: string[],
	config: PetConfig,
	adaptive?: AdaptiveContext,
): Promise<CritiqueVerdict> {
	const failClosed = (summary: string): CritiqueVerdict => ({ available: false, pass: false, issues: [], summary });
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;

	// Deterministic objective gate: cloze structure and sentence word count must
	// respect the budget, and the batch must stay words-majority. This fails before
	// any LLM call so an out-of-budget or malformed item can never be approved,
	// regardless of the model critic's verdict.
	const budgetBlockers: CritiqueIssue[] = [];
	const phraseCount = lesson.items.filter((item) => item.type === "phrase").length;
	if (lesson.items.length === LESSON_WORD_ITEMS + LESSON_CLOZE_ITEMS && phraseCount > LESSON_MAX_PHRASES) {
		budgetBlockers.push({
			severity: "blocker",
			category: "composition",
			description: `词组数量 ${phraseCount} 超过单词为主的批次上限 ${LESSON_MAX_PHRASES}，请减词组换单词`,
		});
	}
	for (const item of lesson.items) {
		if (item.type === "cloze") {
			if (!validClozeItem(item)) {
				budgetBlockers.push({
					severity: "blocker",
					category: "structure",
					description: "语法填空必须恰好包含一个 ___ 且答案（meaning）非空",
				});
				continue;
			}
			const base = (item.example || item.text).replace(/___/g, " x ").replace(/\s*\([^)]*\)/g, "");
			const words = base.trim().split(/\s+/).filter(Boolean).length;
			const [clozeMin, clozeMax] = budget.wordRange;
			if (words < clozeMin || words > clozeMax) {
				budgetBlockers.push({
					severity: "blocker",
					category: "budget",
					description: `语法填空句词数 ${words} 不在预算区间 [${clozeMin}, ${clozeMax}] 内`,
				});
			}
		}
		if (item.type !== "sentence") continue;
		const words = item.text.trim().split(/\s+/).filter(Boolean).length;
		const [minWords, maxWords] = budget.wordRange;
		if (words < minWords || words > maxWords) {
			budgetBlockers.push({
				severity: "blocker",
				category: "budget",
				description: `句子词数 ${words} 不在预算区间 [${minWords}, ${maxWords}] 内`,
			});
		}
		if (item.keyWords && item.keyWords.length > budget.maxKeyWords) {
			budgetBlockers.push({
				severity: "blocker",
				category: "budget",
				description: `生词数 ${item.keyWords.length} 超过预算上限 ${budget.maxKeyWords}`,
			});
		}
	}
	if (budgetBlockers.length) {
		return {
			available: true,
			pass: false,
			issues: budgetBlockers,
			summary: "内容超出难度预算（客观检查失败）",
		};
	}

	// Pass the complete bounded lesson structure (not just an outline) so the critic
	// can judge examples, levels, chunks, and keywords.
	const lessonJson = JSON.stringify(lesson);

	const prompt = [
		"你是「英语小宠物」的内容审查员。审查下面备课是否适合当前学习者水平，只输出 JSON。",
		'{"pass": true/false, "issues": [{"severity":"blocker|minor","category":"fact|sense|dup|translation|natural|progression|budget","description":"..."}], "summary":"一句话"}',
		"审查标准：",
		"- 英语单词/词组/句子必须正确、自然",
		`- 批次组成：${LESSON_WORD_ITEMS} 个单词/词组项以单词为主（词组不超过 ${LESSON_MAX_PHRASES} 个）加 ${LESSON_CLOZE_ITEMS > 1 ? LESSON_CLOZE_ITEMS + " 个语法填空" : "1 个语法填空"}；同批学习项之间不得重复或近乎重复；违反记 blocker`,
		"- cloze 语法填空：___ 空格恰好一个且挖在真正的语法点上；括号原形提示与考点一致；meaning 答案唯一且为最小形式，代入后句子语法正确；若同一空存在其他语法正确的填法（时态/语态歧义）记 blocker；example 必须是代入答案后的完整句子；chunks 必须是 2-6 个意群且拼接覆盖完整句子；违反记 blocker",
		"- 中文释义准确，不得机翻味",
		"- word/phrase 的 meaning 必须是可直接回忆的最小释义，不得混入目的/效果等补充说明（反例：「重新加载，使新改动生效」只能保留「重新加载」），也不得并列近义改写（「生效，起作用」应只写「生效」）；违反记 blocker",
		"- 不得与已学内容重复：" + (known.length ? known.join("、") : "（暂无）"),
		`- cloze 句子须符合预算（词数 ${budget.wordRange[0]}-${budget.wordRange[1]}，句法结构遵循 difficulty_budget）；cloze 句子可以自然复用批次中 1-2 个单词或词组`,
		"- 不得为凑结构硬造不自然句子",
		"- 只有明确问题才标 blocker；小瑕疵标 minor",
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		`<lesson>${lessonJson}</lesson>`,
	].join("\n");

	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语教学内容审查员，只输出 JSON。",
			prompt,
			maxTokens: 2048,
			thinkingLevel: config.thinkingLevel,
		});
	} catch {
		return failClosed("critic call failed");
	}

	const json = extractJsonObjectText(text);
	if (!json) return failClosed("critic bad json");
	try {
		const parsed = JSON.parse(json) as { pass?: unknown; issues?: unknown; summary?: unknown };
		return {
			available: true,
			pass: parsed.pass === true,
			issues: Array.isArray(parsed.issues) ? (parsed.issues as CritiqueIssue[]).slice(0, 20) : [],
			summary: typeof parsed.summary === "string" ? parsed.summary : "",
		};
	} catch {
		return failClosed("critic unparseable");
	}
}

export interface AnswerEvaluation {
	available: boolean;
	verdict: "correct" | "partial" | "incorrect";
	feedback: string;
}

/** LLM evaluation for a near-miss answer. Provider/model/bad-JSON failures leave the card pending with zero writes. */
export async function evaluateAttempt(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	item: ItemRow,
	answer: string,
	resolved: { provider: string; model: string } | undefined,
	direction: "forward" | "reverse" = "forward",
): Promise<AnswerEvaluation> {
	const unavailable = (): AnswerEvaluation => ({ available: false, verdict: "incorrect", feedback: "" });
	if (!resolved) return unavailable();
	const isCloze = item.type === "cloze";
	const isReverse = direction === "reverse";
	const target = isCloze ? item.meaning : isReverse ? item.meaning : item.text;
	const answerLang = isReverse ? "中文" : "英文";
	// Direction-aware rubric: reverse (EN→CN) tests recognition, so any
	// semantically correct Chinese rendering counts (synonym/register variants
	// included); forward (CN→EN) tests production of the exact English item,
	// so spelling stays strict. Cloze grades the grammatical form: a synonymous
	// but differently-formed answer is not correct.
	const rubric = isCloze
		? [
			"- correct: 与目标答案完全一致，或仅大小写差异",
			"- partial: 语法形式接近但有错误（如漏助动词、时态/单复数/拼写错），如目标 was committed 写成 was commit",
			"- incorrect: 不同的词、空白或语言错误；语义相同但语法形式不同的答案不算对",
		]
		: isReverse
		? [
			"- correct: 中文意思与目标释义一致即可；同义表达、简写/全称、语体差异（如“已”与“已经”）都算对，措辞不必逐字相同",
			"- 目标释义并列的多个说法若互为近义（如「生效，起作用」），答出任一近义说法即为 correct，不得因漏掉其余说法判 partial",
			"- partial: 意思基本正确，但有明显遗漏或偏差；遗漏仅指漏掉并列的不同义项（如「银行」与「河岸」只答出其一）",
			"- incorrect: 意思错误、空白、语言错误或无法识别",
		]
		: [
			"- correct: 英文与目标完全一致，或仅大小写/标点/多余空格差异",
			"- partial: 英文有小错（拼写/字形），但明显是想写这个目标词",
			"- incorrect: 完全不同的意思、空白、语言错误或无法识别",
		];
	const prompt = [
		isCloze
			? "你是英语导师。学生要做语法填空，写出空格处正确的语法形式。"
			: `你是英语导师。学生看到${isReverse ? "英文" : "中文"}要写出对应的${answerLang}。`,
		...(isCloze ? [`填空句：${item.text}`] : []),
		`目标：${target}`,
		`学生写了：${answer}`,
		"判断学生的答案，只输出 JSON：",
		'{"verdict":"correct|partial|incorrect","feedback":"简短中文反馈，指出最小问题"}',
		`- 学生必须用${answerLang}作答；写错语言一律 incorrect`,
		...rubric,
	].join("\n");
	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语拼写/词义评价员，只输出 JSON。",
			prompt,
			maxTokens: 1024,
		});
	} catch {
		return unavailable();
	}
	const json = extractJsonObjectText(text);
	if (!json) return unavailable();
	try {
		const parsed = JSON.parse(json) as { verdict?: unknown; feedback?: unknown };
		const verdict = parsed.verdict === "correct" ? "correct" : parsed.verdict === "partial" ? "partial" : "incorrect";
		return { available: true, verdict, feedback: typeof parsed.feedback === "string" ? parsed.feedback : "" };
	} catch {
		return unavailable();
	}
}

export interface SentenceEvaluation extends AnswerEvaluation {
	available: boolean;
	errorTags: string[];
	correctedAnswer: string;
}

/** Semantic sentence-output evaluation. Provider failures leave the card pending with zero writes. */
export async function evaluateSentenceAttempt(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	exercise: SentenceExerciseView,
	answer: string,
	resolved: { provider: string; model: string } | undefined,
): Promise<SentenceEvaluation> {
	const unavailable = (): SentenceEvaluation => ({
		available: false,
		verdict: "incorrect",
		feedback: "",
		errorTags: [],
		correctedAnswer: "",
	});
	const normalize = (value: string) => value
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/[^a-z0-9']+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	const normalizedAnswer = normalize(answer);
	if (
		normalizedAnswer === normalize(exercise.expected) ||
		(exercise.kind === "sentence_cloze" && normalizedAnswer === normalize(exercise.reference))
	) {
		return { available: true, verdict: "correct", feedback: "", errorTags: [], correctedAnswer: exercise.reference };
	}
	if (!resolved) return unavailable();
	const task = exercise.kind === "sentence_cloze"
		? [
			"这是单词填空。学生可以只写缺失词，也可以写完整句子。",
			`缺失词：${exercise.expected}`,
			`填空句：${exercise.cloze}`,
		]
		: [
			"这是开放式中文到英文产出。不要要求与参考句逐字相同。",
			`中文意图：${exercise.chinese}`,
			`参考表达：${exercise.reference}`,
			...(exercise.focusExpression ? [`建议目标表达：${exercise.focusExpression}`] : []),
		];
	const prompt = [
		"你是严格但鼓励性的英语写作导师。评价学生英文，只输出 JSON。",
		...task,
		`学生答案：${answer}`,
		'输出：{"verdict":"correct|partial|incorrect","feedback":"一个最小中文修正","errorTags":["grammar|collocation|meaning|missing_target|word_order|spelling|preposition|tense|article|word_choice"],"correctedAnswer":"自然修正版"}',
		"errorTags 只能从上面列表中选择，拿不准就用 other。",
		"correct：语义满足中文意图且英文自然；自然变体应接受。",
		"partial：意图基本正确，仅有一个或少量可修正问题。",
		"incorrect：核心意思错误、无法理解、写成中文，或填空目标明显错误。",
		"feedback 只指出当前最关键的一个问题，不要长篇讲解。",
	].join("\n");
	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语输出评价员，只输出严格 JSON。",
			prompt,
			maxTokens: 1536,
		});
	} catch {
		return unavailable();
	}
	const json = extractJsonObjectText(text);
	if (!json) return unavailable();
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		const verdict = parsed.verdict === "correct" ? "correct" : parsed.verdict === "partial" ? "partial" : "incorrect";
		const errorTags = Array.isArray(parsed.errorTags)
			? [...new Set(parsed.errorTags.filter((tag): tag is string => typeof tag === "string").map((tag) => normalizeErrorTag(tag)))].slice(0, 5)
			: [];
		return {
			available: true,
			verdict,
			feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
			errorTags,
			correctedAnswer: typeof parsed.correctedAnswer === "string" ? parsed.correctedAnswer : exercise.reference,
		};
	} catch {
		return unavailable();
	}
}

export async function generateReplacement(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
	skipped: ItemRow,
	adaptive?: AdaptiveContext,
	recentLog?: string,
): Promise<ReplacementDecision> {
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;
	const isCloze = skipped.type === "cloze";
	const itemSchema = isCloze
		? '{"type":"cloze","text":"含一个 ___ 的英文句子（空后括号给原形提示）","phonetic":"","meaning":"正确答案","example":"代入答案后的完整句子","example_cn":"整句中文翻译（可附考点说明）","chunks":["意群1","意群2","意群3"]}'
		: `{"type":"${skipped.type}","text":"${skipped.type === "word" ? "单词" : "词组"}","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句翻译"}`;
	const prompt = [
		`用户刚把 ${skipped.type} 卡片「${skipped.text} = ${skipped.meaning}」标记为已经很熟。`,
		`请根据会话主题补充 1 张新的 ${skipped.type} 卡片，不能与已有内容重复。`,
		"如果会话信息不足以生成真实有用的同类型卡片，只输出：{\"ready\":false,\"reason\":\"简短原因\"}。",
		"信息充分时只输出：",
		`{"ready":true,"item":${itemSchema}}`,
		isCloze
			? `语法填空要求：恰好一个 ___、空后括号给原形提示、考点是明确的语法点且答案唯一；meaning 填正确答案的最小形式，text 只放挖空句且句尾不得附加 = 答案或 → 答案，example 是代入答案后的完整句子，chunks 是覆盖完整句子的 2-6 个意群，句子词数在 ${budget.wordRange[0]}-${budget.wordRange[1]} 之间且自然真实。`
			: "内容要真实常用，贴近当前会话主题，难度贴合下面的画像与预算；meaning 只写最小中文释义（直接翻译），只给一个首选说法、不并列近义改写，用途/效果说明放 example/example_cn。",
		"已有内容：" + (known.length ? known.join("；") : "（无）"),
		...(recentLog
			? ["", "最近出题与作答记录（新→旧）：", recentLog, "避免重复近期刚练过的内容；若反馈指向出题缺陷，避免同类出题。"]
			: []),
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");
	// Same-model retry loop: transient output-shape errors (mostly truncated or
	// unparseable JSON) get an immediate retry before the caller's model fallback.
	for (let attempt = 0; ; attempt++) {
		const text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语学习卡生成器，只输出 JSON；信息不足时宁可等待。",
			prompt,
			maxTokens: config.maxTokens,
			thinkingLevel: config.thinkingLevel,
		});
		try {
			return parseReplacementDecision(text, skipped.type);
		} catch (err) {
			if (attempt >= REPLACEMENT_SHAPE_RETRIES || !isTransientShapeError(err)) throw err;
		}
	}
}

function parseReplacementDecision(text: string, expectedType: GeneratedItem["type"]): ReplacementDecision {
	const json = extractJsonObjectText(text);
	if (!json) throw new Error("BAD_JSON");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("BAD_JSON");
	}
	if (parsed.ready === false) {
		return { ready: false, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");
	const item = parseGeneratedItem(parsed.item, expectedType);
	if (!item) throw new Error("EMPTY_REPLACEMENT");
	return { ready: true, item };
}
