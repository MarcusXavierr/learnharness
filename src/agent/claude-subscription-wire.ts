/** Cowork-compatible wire shape for Claude subscription requests sent through
 * pi-ai's Anthropic transport. Wire adaptation only: credentials, leases and
 * request admission stay with the native subscription owner and
 * nativeSubscriptionStream. pi-ai's own OAuth tool-name mapping is retained. */
import { createHash, randomUUID } from "node:crypto";
import xxhash, { type XXHashAPI } from "xxhash-wasm";
import type { TranscriptContext } from "@earendil-works/pi-ai";

/** Claude runtime version advertised on the wire. Anthropic rejects current models below 2.1.280 (claude_code_version_too_old). */
const CLAUDE_CODE_VERSION = "2.1.280";
const CLAUDE_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** pi-ai's OAuth system[0]; replaced by the billing header and Cowork identity. */
const PI_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const MAX_OUTPUT_TOKENS = 64000;
const THINKING_OUTPUT_RESERVE = 1024;
const BILLING_PREFIX = "x-anthropic-billing-header:";
const CCH_PLACEHOLDER = "cch=00000";
const CCH_SEED = 0x4d659218e32a3268n;
/** Maximum bytes between the system[0] billing anchor and its placeholder. */
const CCH_WINDOW = 150;
const AGENT_BETAS = ["claude-code-20250219", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "mid-conversation-system-2026-04-07", "advanced-tool-use-2025-11-20"];
const UTILITY_BETAS = ["interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "structured-outputs-2025-12-15"];
const EFFORT_BETA = "effort-2025-11-24";
const FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";
const STAINLESS_ARCH: Record<string, string> = { x64: "x64", arm64: "arm64", ia32: "x86" };
/** pi-ai's OAuth identity betas: Cowork's lists above replace them. */
const PI_OAUTH_BETAS: Record<string, true> = { "claude-code-20250219": true, "oauth-2025-04-20": true };

const encoder = new TextEncoder();
const BILLING_MARKER = encoder.encode(`"system":[{"type":"text","text":"${BILLING_PREFIX}`);
const PLACEHOLDER = encoder.encode(CCH_PLACEHOLDER);
let hasher: Promise<XXHashAPI> | undefined;

interface TextBlock { type: "text"; text: string; cache_control?: unknown }
function isTextBlock(value: unknown): value is TextBlock {
	return !!value && typeof value === "object" && (value as TextBlock).type === "text" && typeof (value as TextBlock).text === "string";
}
function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function firstUserText(context: TranscriptContext): string {
	const user = context.messages.find((message) => message.role === "user");
	if (!user) return "";
	if (typeof user.content === "string") return user.content;
	return user.content.find((block) => block.type === "text")?.text ?? "";
}

/** Final request body: billing header and Cowork identity before the app's own
 * uncached system blocks, metadata attribution, output cap and Cowork betas. */
export function claudeSubscriptionPayload(payload: unknown, context: TranscriptContext, connectionId: string, sessionId: string): Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Claude subscription payload");
	const raw = payload as Record<string, unknown>;
	const system = raw.system === undefined ? [] : raw.system;
	if (!Array.isArray(system) || !system.every(isTextBlock)) throw new Error("Invalid Claude subscription system prompt");
	const appBlocks = (system[0]?.text === PI_OAUTH_IDENTITY ? system.slice(1) : system).map(({ type, text }) => ({ type, text }));
	const sample = firstUserText(context);
	const fingerprint = sha256(`59cf53e54c78${[4, 7, 20].map((index) => sample[index] ?? "0").join("")}${CLAUDE_CODE_VERSION}`).slice(0, 3);
	const maxTokens = Math.min(typeof raw.max_tokens === "number" ? raw.max_tokens : MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
	let thinking = raw.thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
	if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number" && thinking.budget_tokens > maxTokens - THINKING_OUTPUT_RESERVE) thinking = { ...thinking, budget_tokens: maxTokens - THINKING_OUTPUT_RESERVE };
	const thinkingOn = thinking?.type === "enabled" || thinking?.type === "adaptive";
	const agent = thinkingOn || (Array.isArray(raw.tools) && raw.tools.length > 0);
	const base = agent ? [...AGENT_BETAS, ...(thinkingOn ? [EFFORT_BETA] : []), FALLBACK_CREDIT_BETA] : UTILITY_BETAS;
	const required = (Array.isArray(raw.betas) ? raw.betas : []).filter((beta): beta is string => typeof beta === "string" && !Object.hasOwn(PI_OAUTH_BETAS, beta) && !beta.startsWith("context-1m"));
	return {
		...raw,
		max_tokens: maxTokens,
		...(thinking ? { thinking } : {}),
		betas: [...new Set([...base, ...required])],
		system: [
			{ type: "text", text: `${BILLING_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER};` },
			{ type: "text", text: CLAUDE_AGENT_IDENTITY },
			...appBlocks,
		],
		metadata: { user_id: JSON.stringify({ device_id: sha256(`omp-claude-device-id-v1:${connectionId}`), session_id: sessionId }) },
	};
}

/** Cowork transport identity; merged after caller and leased auth headers. */
export function claudeSubscriptionHeaders(sessionId: string): Record<string, string> {
	return {
		"user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, claude-desktop)`,
		"x-app": "cli",
		"X-Claude-Code-Session-Id": sessionId,
		"x-client-request-id": randomUUID(),
		"X-Stainless-Arch": STAINLESS_ARCH[process.arch] ?? `other::${process.arch}`,
		"X-Stainless-Lang": "js",
		"X-Stainless-OS": "Linux",
		"X-Stainless-Package-Version": "0.94.0",
		"X-Stainless-Retry-Count": "0",
		"X-Stainless-Runtime": "node",
		"X-Stainless-Runtime-Version": "v26.3.0",
		"X-Stainless-Timeout": "600",
	};
}

/** Writes the cch attestation (seeded XXH64 of the whole body, placeholder
 * included, low 20 bits) into the system[0] billing placeholder. Throws rather
 * than return an unattested body. */
export async function patchClaudeSubscriptionBody(body: string): Promise<Uint8Array<ArrayBuffer>> {
	const api = await (hasher ??= xxhash().catch((error: unknown) => { hasher = undefined; throw error; }));
	const bytes = encoder.encode(body), view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const marker = view.indexOf(BILLING_MARKER);
	if (marker < 0) throw new Error("Claude subscription billing header missing");
	const from = marker + BILLING_MARKER.length, at = view.indexOf(PLACEHOLDER, from);
	if (at < 0 || at - from > CCH_WINDOW) throw new Error("Claude subscription billing placeholder missing");
	const cch = (api.h64Raw(bytes, CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
	encoder.encodeInto(cch, bytes.subarray(at + "cch=".length, at + CCH_PLACEHOLDER.length));
	return bytes;
}
