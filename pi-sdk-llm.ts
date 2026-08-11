import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface SdkModelRef {
	provider: string;
	model: string;
}

export interface SdkCompletionRequest {
	systemPrompt: string;
	prompt: string;
	maxTokens: number;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export type PiSdkRuntimeFactory = (ctx: ExtensionContext, provider: string) => Promise<ModelRuntime>;

/**
 * Isolated Pi SDK transport for every tutor LLM call.
 *
 * Each request gets an in-memory AgentSession with no discovered extensions,
 * skills, context files, prompts, themes, or tools. This prevents recursive
 * loading of the tutor extension and keeps the model limited to the supplied
 * teaching task. ModelRuntime instances are cached per provider so configured
 * auth and provider catalogs can be reused without sharing conversation state.
 */
export class PiSdkLlmClient {
	private readonly runtimes = new Map<string, Promise<ModelRuntime>>();
	private readonly runtimeApiKeys = new Map<string, string>();
	private readonly activeSessions = new Set<AgentSession>();
	private readonly runtimeFactory: PiSdkRuntimeFactory | undefined;
	private closed = false;

	constructor(runtimeFactory?: PiSdkRuntimeFactory) {
		this.runtimeFactory = runtimeFactory;
	}

	async complete(
		ctx: ExtensionContext,
		resolved: SdkModelRef,
		request: SdkCompletionRequest,
	): Promise<string> {
		if (this.closed) throw new Error("SDK_LLM_CLIENT_CLOSED");

		const hostModel = ctx.modelRegistry.find(resolved.provider, resolved.model);
		if (!hostModel) {
			const err = new Error("MODEL_NOT_FOUND");
			(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
			throw err;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(hostModel);
		if (!auth.ok || !auth.apiKey) {
			const err = new Error("NO_API_KEY");
			(err as Error & { code?: string }).code = "NO_API_KEY";
			throw err;
		}

		const runtime = await this.runtimeFor(ctx, resolved.provider);
		if (this.runtimeApiKeys.get(resolved.provider) !== auth.apiKey) {
			await runtime.setRuntimeApiKey(resolved.provider, auth.apiKey);
			this.runtimeApiKeys.set(resolved.provider, auth.apiKey);
		}

		const runtimeModel = runtime.getModel(resolved.provider, resolved.model);
		if (!runtimeModel) {
			const err = new Error("SDK_MODEL_NOT_FOUND");
			(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
			throw err;
		}
		const maxTokens = Math.max(1, Math.min(request.maxTokens, runtimeModel.maxTokens ?? request.maxTokens));
		const headers: Record<string, string> = { ...(runtimeModel.headers ?? {}) };
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (typeof value === "string") headers[name] = value;
		}
		const model = { ...runtimeModel, maxTokens, headers };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 2 },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => request.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model,
			modelRuntime: runtime,
			thinkingLevel: request.thinkingLevel ?? "off",
			noTools: "all",
			resourceLoader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager,
		});
		this.activeSessions.add(session);
		try {
			await session.prompt(request.prompt, { expandPromptTemplates: false });
			const error = session.agent.state.errorMessage;
			if (error) throw new Error(error);
			let last: { content?: Array<{ type?: string; text?: string }>; stopReason?: string; errorMessage?: string } | undefined;
			for (let index = session.messages.length - 1; index >= 0; index--) {
				const message = session.messages[index];
				if (message.role === "assistant") {
					last = message as typeof last;
					break;
				}
			}
			if (!last) throw new Error("EMPTY_RESPONSE");
			if (last.stopReason === "error") throw new Error(last.errorMessage || "provider error");
			const textParts: string[] = [];
			for (const part of last.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
			}
			const text = textParts.join(" ").trim();
			if (!text) throw new Error("EMPTY_RESPONSE");
			return text;
		} finally {
			if (this.activeSessions.delete(session)) session.dispose();
		}
	}

	async dispose(): Promise<void> {
		this.closed = true;
		const sessions = [...this.activeSessions];
		await Promise.allSettled(sessions.map((session) => session.abort()));
		for (const session of sessions) {
			if (this.activeSessions.delete(session)) session.dispose();
		}
	}

	private runtimeFor(ctx: ExtensionContext, provider: string): Promise<ModelRuntime> {
		let pending = this.runtimes.get(provider);
		if (!pending) {
			pending = this.createRuntime(ctx, provider);
			this.runtimes.set(provider, pending);
		}
		return pending;
	}

	private async createRuntime(ctx: ExtensionContext, provider: string): Promise<ModelRuntime> {
		if (this.runtimeFactory) return this.runtimeFactory(ctx, provider);
		const runtime = await ModelRuntime.create();
		const getRegisteredProviderConfig = (ctx.modelRegistry as typeof ctx.modelRegistry & {
			getRegisteredProviderConfig?: (providerId: string) => unknown;
		}).getRegisteredProviderConfig;
		const providerConfig = getRegisteredProviderConfig?.call(ctx.modelRegistry, provider);
		if (providerConfig) runtime.registerProvider(provider, providerConfig as never);
		return runtime;
	}
}
