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

export interface PiSdkLlmClientOptions {
	completeTimeoutMs?: number;
	abortTimeoutMs?: number;
}

const DEFAULT_COMPLETE_TIMEOUT_MS = 120_000;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

function clientClosedError(): Error {
	return new Error("SDK_LLM_CLIENT_CLOSED");
}

function completionTimeoutError(): Error {
	return new Error("SDK_LLM_TIMEOUT");
}

async function abortWithinDeadline(session: AgentSession, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			session.abort(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

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
	private readonly completeTimeoutMs: number;
	private readonly abortTimeoutMs: number;
	private readonly lifecycle = new AbortController();
	private closed = false;

	constructor(runtimeFactory?: PiSdkRuntimeFactory, options: PiSdkLlmClientOptions = {}) {
		this.runtimeFactory = runtimeFactory;
		this.completeTimeoutMs = Math.max(1, options.completeTimeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS);
		this.abortTimeoutMs = Math.max(1, options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS);
	}

	async complete(
		ctx: ExtensionContext,
		resolved: SdkModelRef,
		request: SdkCompletionRequest,
	): Promise<string> {
		if (this.closed) throw clientClosedError();
		const deadline = Date.now() + this.completeTimeoutMs;

		const hostModel = ctx.modelRegistry.find(resolved.provider, resolved.model);
		if (!hostModel) {
			const err = new Error("MODEL_NOT_FOUND");
			(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
			throw err;
		}
		const auth = await this.waitFor(ctx.modelRegistry.getApiKeyAndHeaders(hostModel), deadline);
		if (!auth.ok) {
			const err = new Error("NO_API_KEY");
			(err as Error & { code?: string }).code = "NO_API_KEY";
			throw err;
		}

		const runtime = await this.waitFor(this.runtimeFor(ctx, resolved.provider), deadline);
		if (auth.apiKey && this.runtimeApiKeys.get(resolved.provider) !== auth.apiKey) {
			await this.waitFor(runtime.setRuntimeApiKey(resolved.provider, auth.apiKey), deadline);
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
		await this.waitFor(resourceLoader.reload(), deadline);

		const sessionCreation = createAgentSession({
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
		let session: AgentSession;
		try {
			({ session } = await this.waitFor(sessionCreation, deadline));
		} catch (err) {
			// A session created after timeout/dispose is an orphan. Keep a rejection
			// handler attached and dispose it as soon as creation eventually settles.
			void sessionCreation.then(async ({ session: orphan }) => {
				try { await abortWithinDeadline(orphan, this.abortTimeoutMs); } catch { /* already settled */ }
				orphan.dispose();
			}).catch(() => {});
			throw err;
		}
		if (this.closed) {
			session.dispose();
			throw clientClosedError();
		}
		this.activeSessions.add(session);
		try {
			await this.waitFor(session.prompt(request.prompt, { expandPromptTemplates: false }), deadline);
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
		} catch (err) {
			try { await abortWithinDeadline(session, this.abortTimeoutMs); } catch { /* already settled */ }
			throw err;
		} finally {
			if (this.activeSessions.delete(session)) session.dispose();
		}
	}

	async dispose(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.lifecycle.abort();
		}
		const sessions = [...this.activeSessions];
		await Promise.allSettled(sessions.map((session) => abortWithinDeadline(session, this.abortTimeoutMs)));
		for (const session of sessions) {
			if (this.activeSessions.delete(session)) session.dispose();
		}
	}

	private waitFor<T>(operation: Promise<T>, deadline: number): Promise<T> {
		if (this.closed || this.lifecycle.signal.aborted) return Promise.reject(clientClosedError());
		const remaining = deadline - Date.now();
		if (remaining <= 0) return Promise.reject(completionTimeoutError());
		return new Promise<T>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				this.lifecycle.signal.removeEventListener("abort", onAbort);
			};
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				callback();
			};
			const onAbort = () => finish(() => reject(clientClosedError()));
			this.lifecycle.signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => finish(() => reject(completionTimeoutError())), remaining);
			operation.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	}

	private runtimeFor(ctx: ExtensionContext, provider: string): Promise<ModelRuntime> {
		let pending = this.runtimes.get(provider);
		if (!pending) {
			pending = this.createRuntime(ctx, provider);
			this.runtimes.set(provider, pending);
			pending.catch(() => {
				if (this.runtimes.get(provider) === pending) {
					this.runtimes.delete(provider);
					this.runtimeApiKeys.delete(provider);
				}
			});
		}
		return pending;
	}

	private async createRuntime(ctx: ExtensionContext, provider: string): Promise<ModelRuntime> {
		if (this.runtimeFactory) return this.runtimeFactory(ctx, provider);
		const runtime = await ModelRuntime.create();
		const getRegisteredNativeProvider = (ctx.modelRegistry as typeof ctx.modelRegistry & {
			getRegisteredNativeProvider?: (providerId: string) => unknown;
		}).getRegisteredNativeProvider;
		const nativeProvider = getRegisteredNativeProvider?.call(ctx.modelRegistry, provider);
		if (nativeProvider) {
			runtime.registerNativeProvider(
				nativeProvider as Parameters<ModelRuntime["registerNativeProvider"]>[0],
			);
		} else {
			const getRegisteredProviderConfig = (ctx.modelRegistry as typeof ctx.modelRegistry & {
				getRegisteredProviderConfig?: (providerId: string) => unknown;
			}).getRegisteredProviderConfig;
			const providerConfig = getRegisteredProviderConfig?.call(ctx.modelRegistry, provider);
			if (providerConfig) runtime.registerProvider(provider, providerConfig as never);
		}
		return runtime;
	}
}
