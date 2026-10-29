import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import xxhash from "xxhash-wasm";
import { Type } from "typebox";
import { normalizeContext, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { NATIVE_SUBSCRIPTIONS, type NativeSubscriptionSnapshot } from "../src/core/contracts/subscriptions.ts";
import { refreshSubscriptionModels, nativeSubscriptionModels, subscriptionAbortController, subscriptionRequest } from "../src/agent/subscription-bridge.ts";
import { subscriptionHistory } from "../src/agent/subscription-stream.ts";
import { patchClaudeSubscriptionBody } from "../src/agent/claude-subscription-wire.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send"), originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
const xaiKey = process.env.XAI_API_KEY, copilotKey = process.env.COPILOT_GITHUB_TOKEN, anthropicKey = process.env.ANTHROPIC_API_KEY;
let revision = 1, denied = false, sends = 0, claudeLease = "sk-ant-oat01-fixture-oauth-only";
const leaseKey = (providerId: string) => providerId === "anthropic" ? claudeLease : "fixture-oauth-only";
const context = normalizeContext({ messages: [{ role: "user", content: "Offline fixture", timestamp: 0 }] });
function snapshot(background = true): NativeSubscriptionSnapshot {
	return {
		statuses: NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, available: true, connected: true, pending: false, allowBackgroundUse: background, connectionId: `fixture-${p.providerId}`, epoch: 1, authorityRevision: 1, revision })),
		models: Object.fromEntries(NATIVE_SUBSCRIPTIONS.map((p) => [p.providerId, piModels().getModels(p.providerId)])),
	};
}
const emit = (value: unknown) => (process.emit as (event: string, value: unknown) => boolean)("message", value);
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	process.env.XAI_API_KEY = "fixture-must-never-be-used"; process.env.COPILOT_GITHUB_TOKEN = "fixture-api-route-only"; process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fixture-must-never-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		sends++; queueMicrotask(() => emit({ channel: "lh:subscriptions", id: message.id, op: message.op, ...(denied && message.op === "lease" ? { ok: false, error: "fixture expired refresh" } : { ok: true, value: message.op === "snapshot" ? snapshot() : { scope: message.scope, auth: { apiKey: leaseKey(message.scope.providerId), ...(message.scope.providerId === "github-copilot" ? { baseUrl: "https://api.business.githubcopilot.com", headers: { "x-fixture-auth": "native-retained" } } : {}) } } }) }));
		callback?.(); return true;
	} });
	await refreshSubscriptionModels();
});
after(() => {
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	for (const [key, value] of [["LH_DESKTOP_SERVER", marker], ["LH_DESKTOP_API_SECRET", secret], ["XAI_API_KEY", xaiKey], ["COPILOT_GITHUB_TOKEN", copilotKey], ["ANTHROPIC_API_KEY", anthropicKey]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
});
test("logical subscription routes are separate catalog entries without rewriting native API models", () => {
	for (const p of NATIVE_SUBSCRIPTIONS) {
		assert(nativeSubscriptionModels().some((m) => m.provider === p.logicalId));
		assert(piModels().getModels(p.providerId).every((m) => m.provider === p.providerId));
	}
});
for (const p of NATIVE_SUBSCRIPTIONS) test(`${p.providerId}: every SDK transport keeps native identity, account auth and selected model before dispatch`, async () => {
	const apis = new Set<string>();
	for (const native of piModels().getModels(p.providerId)) {
		if (apis.has(native.api)) continue; apis.add(native.api);
		const engine = piEngineForSpec({ provider: p.logicalId, id: native.id }, false);
		let requests = 0, payloadObserved = false;
		const result = await engine.streamFn(engine.model, context, {
			onPayload: (raw, selected) => { payloadObserved = true; assert.equal(selected.provider, p.providerId); return { ...raw as object, model: "caller-cannot-replace-selected" }; },
			fetch: async (input, init) => {
				requests++; const request = new Request(input, init), body = await request.json();
				assert.equal(request.headers.get("authorization"), `Bearer ${leaseKey(p.providerId)}`); assert.equal(request.headers.get("x-api-key"), null);
				assert.equal(body.model, native.id);
				if (p.providerId === "github-copilot") { assert.equal(new URL(request.url).origin, "https://api.business.githubcopilot.com"); assert.equal(request.headers.get("x-fixture-auth"), "native-retained"); }
				else assert.equal(new URL(request.url).origin, p.providerId === "anthropic" ? "https://api.anthropic.com" : "https://api.x.ai");
				return new Response('{"error":{"message":"private-fixture-provider-detail"}}', { status: 401, headers: { "content-type": "application/json" } });
			},
		}).result();
		assert(payloadObserved); assert.equal(requests, 1); assert.equal(result.provider, p.logicalId); assert.equal(result.stopReason, "error");
		assert(!result.errorMessage?.includes("private-fixture-provider-detail")); assert(result.errorMessage?.includes("No API-key fallback"));
	}
});
test("failed OAuth lease never dispatches despite valid-looking ambient keys; forbidden auth overrides do not dispatch", async () => {
	let requests = 0; denied = true;
	try {
		for (const p of NATIVE_SUBSCRIPTIONS) {
			const model = piModels().getModels(p.providerId)[0]!, engine = piEngineForSpec({ provider: p.logicalId, id: model.id }, false);
			const fetch = async () => { requests++; throw new Error("must not dispatch"); };
			assert.equal((await engine.streamFn(engine.model, context, { fetch }).result()).stopReason, "error");
			assert.equal((await engine.streamFn(engine.model, context, { fetch, headers: { AUTHORIZATION: null } }).result()).stopReason, "error");
		}
		assert.equal(requests, 0);
	} finally { denied = false; }
});
test("a helper refused before dispatch reports no phantom usage or extraction step", async () => {
	denied = true; let usage = 0, steps = 0;
	try {
		const model = piModels().getModels("xai")[0]!, engine = piEngineForSpec({ provider: "xai-subscription", id: model.id });
		await assert.rejects(runSubagent([], { role: "researcher", engine, systemPrompt: "Offline fixture", prompt: "Do not dispatch", maxTurns: 1, onUsage: () => { usage++; }, onAssistantMessage: () => { steps++; } }));
		assert.equal(usage, 0); assert.equal(steps, 0);
	} finally { denied = false; }
});
test("history treatment distinguishes the same model through API and subscription, retaining only own reasoning signatures", () => {
	const native = piModels().getModels("xai")[0]!;
	const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const message: AssistantMessage = { role: "assistant", provider: "xai", api: native.api, model: native.id, timestamp: 0, stopReason: "stop", usage, content: [{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"private-api-signature"}', redacted: true }] };
	const own: AssistantMessage = { ...message, provider: "xai-subscription", content: [{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"own-signature"}', redacted: true }] };
	const logical: Model<Api> = { ...native, provider: "xai-subscription" };
	const transformed = subscriptionHistory(normalizeContext({ messages: [message, own] }), logical, "xai");
	assert.deepEqual((transformed.messages[0] as AssistantMessage).content, []);
	assert.equal((transformed.messages[1] as AssistantMessage).content[0]!.type, "thinking");
	assert.equal(message.content.length, 1);
});
test("background invalidation is provider-specific and preserves foreground controllers; stale updates cannot reenable it", () => {
	const foreground = subscriptionAbortController("xai", false), background = subscriptionAbortController("xai", true), other = subscriptionAbortController("github-copilot", true);
	revision++; const next = snapshot(); next.statuses.find((s) => s.providerId === "xai")!.allowBackgroundUse = false;
	emit({ channel: "lh:subscriptions", op: "changed", snapshot: next });
	assert(!foreground.controller.signal.aborted); assert(background.controller.signal.aborted); assert(!other.controller.signal.aborted);
	const stale = snapshot(); stale.statuses.forEach((s) => { s.revision = 0; }); emit({ channel: "lh:subscriptions", op: "changed", snapshot: stale });
	foreground.release(); background.release(); other.release();
});
const CCH_SEED = 0x4d659218e32a3268n, hasher = await xxhash(), encoder = new TextEncoder();
const BILLING = /^x-anthropic-billing-header: cc_version=2\.1\.280\.([0-9a-f]{3}); cc_entrypoint=claude-desktop; cch=([0-9a-f]{5});$/;
const COWORK_AGENT_BETAS = ["claude-code-20250219", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "mid-conversation-system-2026-04-07", "advanced-tool-use-2025-11-20"];
const COWORK_UTILITY_BETAS = ["interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "structured-outputs-2025-12-15"];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function claudeEvents(events: { type: string }[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}
const claudeStart = (model: string) => ({ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
interface SentClaudeRequest { request: Request; text: string; body: any }
async function claudeRequest(input: string | URL | Request, init?: RequestInit): Promise<SentClaudeRequest> {
	const request = new Request(input, init), text = new TextDecoder().decode(await request.arrayBuffer());
	return { request, text, body: JSON.parse(text) };
}
function assertAttested(text: string, firstUserText: string): void {
	const billing = BILLING.exec(JSON.parse(text).system[0].text); assert(billing, "billing header missing");
	assert.equal(billing[1], sha256(`59cf53e54c78${[4, 7, 20].map((i) => firstUserText[i] ?? "0").join("")}2.1.280`).slice(0, 3));
	const prepatch = text.replace(`cch=${billing[2]};`, "cch=00000;");
	assert.equal(billing[2], (hasher.h64Raw(encoder.encode(prepatch), CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0"), "cch must attest the whole prepatch body");
}
test("XXH64 cch: independent vectors match, and only the anchored billing placeholder is patched or the body fails closed", async () => {
	assert.equal(hasher.h64Raw(encoder.encode("claude cch fixture"), CCH_SEED).toString(16), "204ff3375c6bff89");
	const body = '{"model":"claude-fixture","messages":[{"role":"user","content":"cch=00000 in user text"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.abc; cc_entrypoint=claude-desktop; cch=00000;"},{"type":"text","text":"Learner"}]}';
	assert.equal(new TextDecoder().decode(await patchClaudeSubscriptionBody(body)), body.replace('cch=00000;"}', 'cch=2365e;"}'));
	for (const unanchored of [body.replace('[{"type":"text","text":"x-anthropic', '[{"text":"x-anthropic'), body.replace("claude-desktop; cch=00000;", `claude-desktop;${" ".repeat(160)}cch=00000;`), '{"model":"claude-fixture","system":[{"type":"text","text":"x-anthropic-billing-header: cch=12345;"}]}']) {
		await assert.rejects(patchClaudeSubscriptionBody(unanchored));
	}
});
test("Anthropic subscription turn: Cowork identity, attested billing, stable device and per-chat session; pi-ai tool names round-trip", async () => {
	const native = piModels().getModels("anthropic").find((m) => m.id === "claude-sonnet-4-5")!;
	const engine = piEngineForSpec({ provider: "anthropic-subscription", id: native.id, thinkingLevel: "high" }, false);
	const firstUser = "Teach me how becoming unites being and nothing";
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const input: Context = {
		systemPrompt: "Learner system instructions",
		tools: [{ name: "read", description: "Read a learner note", parameters: Type.Object({ path: Type.String() }) }, { name: "ask_question", description: "Ask the learner a quiz question", parameters: Type.Object({ question: Type.String() }) }],
		messages: [
			{ role: "user", content: firstUser, timestamp: 0 },
			{ role: "assistant", provider: "anthropic-subscription", api: native.api, model: native.id, timestamp: 1, stopReason: "toolUse", usage, content: [{ type: "toolCall", id: "toolu_prior", name: "ask_question", arguments: { question: "What is pure being?" } }] },
			{ role: "toolResult", toolCallId: "toolu_prior", toolName: "ask_question", content: [{ type: "text", text: "Learner answered: indeterminate immediacy" }], isError: false, timestamp: 2 },
		],
	};
	let sent: SentClaudeRequest | undefined;
	const result = await engine.streamFn(engine.model, normalizeContext(input), { sessionId: "chat_fixture", fetch: async (url, init) => {
		assert(!sent, "one request only"); sent = await claudeRequest(url, init);
		return claudeEvents([claudeStart(native.id),
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: "Read", input: {} } } as { type: string },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"notes.md"}' } } as { type: string },
			{ type: "content_block_stop", index: 0 } as { type: string },
			{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } } as { type: string },
			{ type: "message_stop" }]);
	} }).result();
	assert(sent); const { request, text, body } = sent;
	assert.equal(request.url, "https://api.anthropic.com/v1/messages?beta=true");
	assert.equal(request.headers.get("authorization"), "Bearer sk-ant-oat01-fixture-oauth-only"); assert.equal(request.headers.get("x-api-key"), null);
	assert.equal(request.headers.get("user-agent"), "claude-cli/2.1.280 (external, claude-desktop)"); assert.equal(request.headers.get("x-app"), "cli");
	assert.equal(request.headers.get("x-claude-code-session-id"), "chat_fixture"); assert.match(request.headers.get("x-client-request-id") ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const arch = { x64: "x64", arm64: "arm64", ia32: "x86" }[process.arch as string] ?? `other::${process.arch}`;
	for (const [name, value] of Object.entries({ arch, lang: "js", os: "Linux", "package-version": "0.94.0", "retry-count": "0", runtime: "node", "runtime-version": "v26.3.0", timeout: "600" })) assert.equal(request.headers.get(`x-stainless-${name}`), value, name);
	const betas = request.headers.get("anthropic-beta")!.split(",");
	assert.deepEqual(betas.slice(0, COWORK_AGENT_BETAS.length + 2), [...COWORK_AGENT_BETAS, "effort-2025-11-24", "fallback-credit-2026-06-01"]);
	assert.equal(new Set(betas).size, betas.length); assert(!betas.includes("oauth-2025-04-20")); assert(!betas.some((beta) => beta.startsWith("context-1m")));
	assert.equal(body.model, native.id); assert.equal(body.betas, undefined);
	assertAttested(text, firstUser);
	assert.deepEqual(body.system.slice(1), [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }, { type: "text", text: "Learner system instructions" }]);
	assert.equal(body.system.length, 3); assert(!text.includes("You are Claude Code"));
	assert.deepEqual(JSON.parse(body.metadata.user_id), { device_id: sha256("omp-claude-device-id-v1:fixture-anthropic"), session_id: "chat_fixture" });
	assert(body.max_tokens <= 64000); assert.equal(body.thinking.type, "enabled"); assert(body.thinking.budget_tokens <= body.max_tokens - 1024);
	assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["Read", "ask_question"]);
	assert.equal(body.messages[1].content.find((block: { type: string }) => block.type === "tool_use").name, "ask_question");
	assert.equal(body.messages[2].content[0].tool_use_id, "toolu_prior");
	assert.equal(result.provider, "anthropic-subscription"); assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.filter((block) => block.type === "toolCall").map((block) => [block.name, block.arguments]), [["read", { path: "notes.md" }]]);
});
test("Anthropic utility turn without tools or thinking uses Cowork utility betas and one generated session for header and metadata", async () => {
	const native = piModels().getModels("anthropic").find((m) => m.id === "claude-sonnet-4-5")!;
	const engine = piEngineForSpec({ provider: "anthropic-subscription", id: native.id, thinkingLevel: "off" }, false);
	let sent: SentClaudeRequest | undefined;
	const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: [{ type: "text", text: "Quiz me" }], timestamp: 0 }] }), { fetch: async (url, init) => {
		sent = await claudeRequest(url, init);
		return claudeEvents([claudeStart(native.id),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as { type: string },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "What is becoming?" } } as { type: string },
			{ type: "content_block_stop", index: 0 } as { type: string },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } } as { type: string },
			{ type: "message_stop" }]);
	} }).result();
	assert(sent); const { request, text, body } = sent;
	const betas = request.headers.get("anthropic-beta")!.split(",");
	assert.deepEqual(betas.slice(0, COWORK_UTILITY_BETAS.length), COWORK_UTILITY_BETAS); assert(!betas.includes("claude-code-20250219")); assert(!betas.includes("oauth-2025-04-20"));
	const user = JSON.parse(body.metadata.user_id);
	assert.equal(user.device_id, sha256("omp-claude-device-id-v1:fixture-anthropic")); assert.match(user.session_id, /^[0-9a-f-]{36}$/);
	assert.equal(request.headers.get("x-claude-code-session-id"), user.session_id);
	assertAttested(text, "Quiz me");
	assert.deepEqual(body.system, [body.system[0], { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }]);
	assert.equal(result.stopReason, "stop"); assert.deepEqual(result.content, [{ type: "text", text: "What is becoming?" }]);
});
test("an Anthropic lease that is not a Claude OAuth token fails before dispatch", async () => {
	const native = piModels().getModels("anthropic")[0]!, engine = piEngineForSpec({ provider: "anthropic-subscription", id: native.id }, false);
	claudeLease = "sk-ant-api03-not-a-subscription-token"; let requests = 0;
	try {
		const result = await engine.streamFn(engine.model, context, { fetch: async () => { requests++; throw new Error("must not dispatch"); } }).result();
		assert.equal(result.stopReason, "error"); assert.equal(requests, 0); assert(result.errorMessage?.includes("No API-key fallback"));
	} finally { claudeLease = "sk-ant-oat01-fixture-oauth-only"; }
});
test("framework IPC alone cannot request subscription credentials or retain a usable catalog", async () => {
	const previous = sends; delete process.env.LH_DESKTOP_SERVER;
	await assert.rejects(subscriptionRequest("snapshot"), /desktop app/); assert.equal(sends, previous); assert.deepEqual(nativeSubscriptionModels(), []);
	process.env.LH_DESKTOP_SERVER = "1";
});
