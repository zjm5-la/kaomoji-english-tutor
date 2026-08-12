import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PetConfig } from "./config.ts";
import type { PiSdkLlmClient } from "./pi-sdk-llm.ts";
import type { ItemRow } from "./db.ts";
import type { SentenceExerciseView } from "./render.ts";

// -- LLM lesson generation ------------------------------------------------

export interface GeneratedItem {
	type: "word" | "phrase" | "sentence";
	text: string;
	phonetic?: string;
	meaning: string;
	example?: string;
	example_cn?: string;
	/** Sentence only: 3 progressive levels (main clause -> full sentence). */
	levels?: string[];
	/** Sentence only: per-level Chinese translations, aligned with levels. */
	levels_cn?: string[];
	/** Sentence only: chunking of the full sentence for guided reading. */
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
	if (type !== "word" && type !== "phrase" && type !== "sentence") return undefined;
	if (expectedType && type !== expectedType) return undefined;
	if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) return undefined;
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
	};
	if (type === "sentence") {
		if (record.levels != null && !(item.levels = stringArray(record.levels))) return undefined;
		if (record.levels_cn != null && !(item.levels_cn = stringArray(record.levels_cn))) return undefined;
		if (record.chunks != null && !(item.chunks = stringArray(record.chunks))) return undefined;
		if (record.keyWords != null && !(item.keyWords = keyWordArray(record.keyWords))) return undefined;
	}
	return item;
}

function validSentenceTraining(item: GeneratedItem): boolean {
	if (item.type !== "sentence" || !item.levels || !item.levels_cn || !item.chunks || !item.keyWords) return false;
	const fullWords = item.text.trim().split(/\s+/).length;
	const middleWords = item.levels[1]?.trim().split(/\s+/).length ?? 0;
	return (
		fullWords >= 15 &&
		item.levels.length === 3 &&
		new Set(item.levels.map((level) => level.trim())).size === 3 &&
		item.levels_cn.length === 3 &&
		item.chunks.length >= 2 && item.chunks.length <= 5 &&
		item.keyWords.length >= 1 && item.keyWords.length <= 3 &&
		item.levels[2].trim() === item.text.trim() &&
		middleWords / fullWords >= 0.35 && middleWords / fullWords <= 0.9
	);
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

export async function generateLesson(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
	feedback?: CritiqueIssue[],
): Promise<LessonDecision> {
	const prompt = [
		"你是「英语小宠物」的备课大脑。先判断下面的会话是否已经形成值得学习的明确主题。",
		"如果信息不足，只输出：{\"ready\":false,\"reason\":\"简短原因\"}。不要为了完成任务硬凑学习卡。",
		"只有信息充分时，才围绕主题准备 3 个学习项：1 个单词、1 个词组、1 个渐进长句。",
		"",
		"备课条件：",
		"- 只要会话中出现过真实、常用的英语表达（单词、词组、完整句子），就可以备课",
		"- 技术开发、工具使用、报错排查、代码评审都是有效话题，提取其中值得中级学习者掌握的英语",
		"- 只有纯寒暄、单字命令、无意义占位或环境通知才返回 ready=false",
		"- 有英语内容就倾向 ready=true，不要因为话题不够像传统英语课而拒绝",
		"",
		"学习项要求：",
		"- 内容要真实常用，宁简单不冷僻，适合中级学习者",
		"- word 和 phrase 的例句短小自然，贴近主题的实际使用场景",
		"- 教学项必须关联：word 的 text 必须自然出现在 sentence 的 text 中；phrase 尽量出现在 sentence 中，形成一个统一的教学单元",
		"- sentence 的 text 必须是真正的长句：至少 15 个单词，包含从句或插入成分；禁止用简单句或短句充数",
		"- 长句结构要多样化：定语从句、状语从句、宾语从句、插入语、分词短语、同位语等轮换使用，避免总是使用 which 定语从句",
		"- sentence 必须带 levels（3 个渐进级别，最后一级与 text 相同）、levels_cn（与 levels 一一对应的逐级中文翻译）、chunks（3-5 个意群）、keyWords（2-3 个生词）",
		"- levels 必须均匀递进且互不相同：每一级只增加一个主要意群，L2 的词数应约为 L3 的 50%-75%，禁止从很短的 L2 突然跳到完整长句",
		"- levels_cn 必须是自然地道的中文，准确对应各级英文，避免逐字直译和同词重复造成的生硬表达",
		"- 只输出 JSON，不要任何其他文字：",
		'{"ready":true,"topic":"主题名","items":[{"type":"word","text":"单词","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"},{"type":"phrase","text":"词组","phonetic":"","meaning":"中文释义","example":"英文例句","example_cn":"例句中文翻译"},{"type":"sentence","text":"完整长句","phonetic":"","meaning":"完整长句的中文翻译","example":"","example_cn":"","levels":["主干短句","加一个成分后的句子","与text相同的完整长句"],"levels_cn":["主干短句的翻译","第二级的翻译","完整长句的翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"中文释义"}]}]}',
		"- 不要与已学内容重复，也要避开相同句型：" + (known.length ? known.join("、") : "（暂无已学内容）"),
		...(feedback && feedback.length
			? ["", "上一次备课被审查拒绝，请针对以下问题改进（不要原样重复被拒内容）：",
				...feedback.map((i) => `- [${i.severity}] ${i.category}: ${i.description}`)]
			: []),
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

	if (!Array.isArray(parsed.items) || parsed.items.length !== 3) throw new Error("INVALID_LESSON_SHAPE");
	const parsedItems = parsed.items.map((item) => parseGeneratedItem(item));
	if (parsedItems.some((item) => item == null)) throw new Error("INVALID_LESSON_ITEM");
	const items = parsedItems as GeneratedItem[];
	if (new Set(items.map((item) => item.type)).size !== 3) throw new Error("INVALID_LESSON_SHAPE");

	// Sentence cards need levels/chunks/keyWords for progressive training.
	// Models sometimes omit them — backfill with a dedicated follow-up call.
	for (const it of items) {
		if (it.type === "sentence" && !validSentenceTraining(it)) {
			await completeSentenceData(llm, ctx, resolved, config, it);
		}
	}
	const sentence = items.find((item) => item.type === "sentence")!;
	if (!validSentenceTraining(sentence)) throw new Error("INVALID_SENTENCE_TRAINING");

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
): Promise<CritiqueVerdict> {
	const failClosed = (summary: string): CritiqueVerdict => ({ available: false, pass: false, issues: [], summary });
	// Pass the complete bounded lesson structure (not just an outline) so the critic
	// can judge examples, levels, chunks, and keywords.
	const lessonJson = JSON.stringify(lesson);

	const prompt = [
		"你是「英语小宠物」的内容审查员。审查下面备课是否适合中级学习者，只输出 JSON。",
		'{"pass": true/false, "issues": [{"severity":"blocker|minor","category":"fact|sense|dup|translation|natural|progression","description":"..."}], "summary":"一句话"}',
		"审查标准：",
		"- 英语单词/词组/句子必须正确、自然",
		"- 中文释义准确，不得机翻味",
		"- 不得与已学内容重复：" + (known.length ? known.join("、") : "（暂无）"),
		"- 长句至少 15 词、含从句；levels 必须逐级递进、不得突变；chunks 和 levels 必须一致",
		"- 单词必须自然出现在句子中",
		"- 不得为凑结构硬造不自然句子",
		"- 只有明确问题才标 blocker；小瑕疵标 minor",
		"",
		`<lesson>${lessonJson}</lesson>`,
	].join("\n");

	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语教学内容审查员，只输出 JSON。",
			prompt,
			maxTokens: 450,
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
	const isReverse = direction === "reverse";
	const target = isReverse ? item.meaning : item.text;
	const answerLang = isReverse ? "中文" : "英文";
	const prompt = [
		`你是英语导师。学生看到${isReverse ? "英文" : "中文"}要写出对应的${answerLang}。`,
		`目标：${target}`,
		`学生写了：${answer}`,
		"判断学生的答案，只输出 JSON：",
		'{"verdict":"correct|partial|incorrect","feedback":"简短中文反馈，指出最小问题"}',
		`- 学生必须用${answerLang}作答；写错语言一律 incorrect`,
		`- correct: ${answerLang}与目标完全一致，或仅大小写/标点/多余空格差异`,
		`- partial: ${answerLang}有小错（拼写/近义/字形），但明显是想表达这个意思`,
		"- incorrect: 完全不同的意思、空白、语言错误或无法识别",
	].join("\n");
	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语拼写/词义评价员，只输出 JSON。",
			prompt,
			maxTokens: 200,
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
		'输出：{"verdict":"correct|partial|incorrect","feedback":"一个最小中文修正","errorTags":["grammar|collocation|meaning|missing_target|word_order|spelling"],"correctedAnswer":"自然修正版"}',
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
			maxTokens: 350,
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
			? parsed.errorTags.filter((tag): tag is string => typeof tag === "string").slice(0, 5)
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
): Promise<ReplacementDecision> {
	const itemSchema = skipped.type === "sentence"
		? '{"type":"sentence","text":"完整长句","meaning":"中文翻译","levels":["L1主干","L2扩展","与text相同的L3"],"levels_cn":["L1翻译","L2翻译","L3翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"释义"}]}'
		: `{"type":"${skipped.type}","text":"${skipped.type === "word" ? "单词" : "词组"}","phonetic":"/音标/","meaning":"中文释义","example":"英文例句","example_cn":"例句翻译"}`;
	const prompt = [
		`用户刚把 ${skipped.type} 卡片「${skipped.text} = ${skipped.meaning}」标记为已经很熟。`,
		`请根据会话主题补充 1 张新的 ${skipped.type} 卡片，不能与已有内容重复。`,
		"如果会话信息不足以生成真实有用的同类型卡片，只输出：{\"ready\":false,\"reason\":\"简短原因\"}。",
		"信息充分时只输出：",
		`{"ready":true,"item":${itemSchema}}`,
		skipped.type === "sentence"
			? "句子必须至少 15 个单词；levels 均匀递进且互不相同，L2 约为 L3 的 50%-75%；逐级翻译使用自然中文。"
			: "内容要真实常用，贴近当前会话主题，适合中级学习者。",
		"已有内容：" + (known.length ? known.join("；") : "（无）"),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");
	const text = await llm.complete(ctx, resolved, {
		systemPrompt: "你是英语学习卡生成器，只输出 JSON；信息不足时宁可等待。",
		prompt,
		maxTokens: skipped.type === "sentence" ? config.maxTokens : 450,
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
		return { ready: false, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");
	const item = parseGeneratedItem(parsed.item, skipped.type);
	if (!item) throw new Error("EMPTY_REPLACEMENT");
	if (item.type === "sentence" && !validSentenceTraining(item)) {
		await completeSentenceData(llm, ctx, resolved, config, item);
	}
	if (item.type === "sentence" && !validSentenceTraining(item)) throw new Error("INVALID_REPLACEMENT_SENTENCE");
	return { ready: true, item };
}

/** Backfill levels/chunks/keyWords for a sentence card via a focused call. */
async function completeSentenceData(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	config: PetConfig,
	item: GeneratedItem,
) {
	const prompt = [
		"为下面的英文句子生成长句训练数据，只输出 JSON：",
		'{"levels":["主干短句（去掉所有修饰成分，同一语义）","主干+一个修饰成分","与原文完全相同的完整长句"],"levels_cn":["主干短句的中文翻译","加一个成分后的中文翻译","完整长句的中文翻译"],"chunks":["意群1","意群2","意群3"],"keyWords":[{"text":"生词","phonetic":"/音标/","meaning":"中文释义"}]}',
		"要求：levels 最后一级必须与原文完全相同；三个级别互不相同，每级只增加一个主要意群，L2 词数约为 L3 的 50%-75%；levels_cn 与 levels 一一对应，使用自然地道的中文；chunks 是原文的意群切分（3-5 个）；keyWords 是句中 2-3 个可能生僻的词（含音标和中文释义）。",
		"",
		"<sentence>",
		item.text,
		"</sentence>",
	].join("\n");

	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语学习卡生成器，只输出 JSON。",
			prompt,
			maxTokens: 500,
			thinkingLevel: config.thinkingLevel,
		});
	} catch {
		return;
	}

	const json = extractJsonObjectText(text);
	if (!json) return;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json);
	} catch {
		return;
	}

	const levels = stringArray(parsed.levels);
	const levelsCn = stringArray(parsed.levels_cn);
	const chunks = stringArray(parsed.chunks);
	const keyWords = keyWordArray(parsed.keyWords);
	if (levels?.length === 3) {
		levels[2] = item.text;
		item.levels = levels;
	}
	if (levelsCn?.length === 3) item.levels_cn = levelsCn;
	if (chunks) item.chunks = chunks;
	if (keyWords) item.keyWords = keyWords;
}
