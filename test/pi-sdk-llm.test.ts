import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider, streamSimple as streamModel } from "@earendil-works/pi-ai/compat";

const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-sdk-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
const { PiSdkLlmClient } = await import("../pi-sdk-llm.ts");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

function testContext(registration: ReturnType<typeof registerFauxProvider>) {
	const model = registration.getModel();
	const modelRegistry = {
		getAvailable: () => [model],
		find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
	};
	return { cwd: agentDir, model, modelRegistry } as any;
}

function fauxRuntime(ctx: any) {
	return {
		getModel: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
		hasConfiguredAuth: () => true,
		setRuntimeApiKey: async () => {},
		streamSimple: async (model: any, context: any, options: any) => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error("NO_API_KEY");
			return streamModel(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
		},
	} as any;
}

test("rejected SDK runtime creation is evicted so the next call can recover", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-retry" });
	try {
		registration.setResponses([fauxAssistantMessage("recovered")]);
		const ctx = testContext(registration);
		let factoryCalls = 0;
		const client = new PiSdkLlmClient(async () => {
			factoryCalls++;
			if (factoryCalls === 1) throw new Error("transient runtime failure");
			return fauxRuntime(ctx);
		});
		const request = { systemPrompt: "Reply briefly.", prompt: "test", maxTokens: 20 };
		const resolved = { provider: ctx.model.provider, model: ctx.model.id };
		await assert.rejects(client.complete(ctx, resolved, request), /transient runtime failure/);
		assert.equal(await client.complete(ctx, resolved, request), "recovered");
		assert.equal(factoryCalls, 2);
		await client.dispose();
	} finally {
		registration.unregister();
	}
});

test("native host providers are copied into the isolated runtime", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-native" });
	const originalCreate = ModelRuntime.create;
	try {
		registration.setResponses([fauxAssistantMessage("native-ok")]);
		const ctx = testContext(registration);
		const nativeProvider = { id: ctx.model.provider };
		ctx.modelRegistry.getRegisteredNativeProvider = (provider: string) => provider === ctx.model.provider ? nativeProvider : undefined;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, headers: { "x-native-auth": "local" } });
		let copied: unknown;
		const runtime = fauxRuntime(ctx) as any;
		runtime.registerNativeProvider = (provider: unknown) => { copied = provider; };
		runtime.streamSimple = async (model: any, context: any, options: any) =>
			streamModel(model, context, { ...options, apiKey: "native-test-key" });
		(ModelRuntime as any).create = async () => runtime;
		const client = new PiSdkLlmClient();
		assert.equal(
			await client.complete(ctx, { provider: ctx.model.provider, model: ctx.model.id }, { systemPrompt: "Reply briefly.", prompt: "test", maxTokens: 20 }),
			"native-ok",
		);
		assert.equal(copied, nativeProvider);
		await client.dispose();
	} finally {
		(ModelRuntime as any).create = originalCreate;
		registration.unregister();
	}
});

test("the completion deadline covers auth before session creation", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-auth-timeout" });
	try {
		const model = registration.getModel();
		const never = new Promise<never>(() => {});
		const ctx = {
			cwd: agentDir,
			model,
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: () => never,
			},
		} as any;
		let factoryCalls = 0;
		const client = new PiSdkLlmClient(async () => { factoryCalls++; return fauxRuntime(ctx); }, { completeTimeoutMs: 20, abortTimeoutMs: 20 });
		await assert.rejects(
			client.complete(ctx, { provider: model.provider, model: model.id }, { systemPrompt: "test", prompt: "test", maxTokens: 20 }),
			/SDK_LLM_TIMEOUT/,
		);
		assert.equal(factoryCalls, 0);
		await client.dispose();
	} finally {
		registration.unregister();
	}
});

test("dispose during pending auth prevents runtime and session creation", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-dispose" });
	try {
		const model = registration.getModel();
		let resolveAuth!: (value: { ok: true; apiKey: string; headers: {} }) => void;
		let authStarted!: () => void;
		const started = new Promise<void>((resolve) => { authStarted = resolve; });
		const auth = new Promise<{ ok: true; apiKey: string; headers: {} }>((resolve) => { resolveAuth = resolve; });
		const ctx = {
			cwd: agentDir,
			model,
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: () => { authStarted(); return auth; },
			},
		} as any;
		let factoryCalls = 0;
		const client = new PiSdkLlmClient(async () => { factoryCalls++; return fauxRuntime(ctx); });
		const completion = client.complete(ctx, { provider: model.provider, model: model.id }, { systemPrompt: "test", prompt: "test", maxTokens: 20 });
		await started;
		await client.dispose();
		resolveAuth({ ok: true, apiKey: "test-key", headers: {} });
		await assert.rejects(completion, /SDK_LLM_CLIENT_CLOSED/);
		assert.equal(factoryCalls, 0, "dispose before auth completion must not create a runtime or session");
	} finally {
		registration.unregister();
	}
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
