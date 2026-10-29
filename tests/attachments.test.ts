/**
 * Session context attachments (2026-10-29) — the server path end to end
 * with zero tokens: files go through the real upload route, the learner's
 * message goes through handleChatRequest, and a scripted pi engine plays
 * the model — recording the system prompt, tool registry and messages it
 * was given, and calling the attachment readers like a real model would.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep, type SystemMessage } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { deleteChatSession } from "../src/server/chats.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { attachmentsDir } from "../src/store/attachments.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import type { AttachmentRecord } from "../src/core/contracts.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";
import { makeEpub } from "./fixtures/make-epub.ts";

const attachmentsRoute = await import("../app/api/chats/[id]/attachments/route.ts");

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const PDF = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"));
/** A valid 1×1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

interface Seen {
	systemPrompt: string;
	tools: string[];
	messages: Array<{ role: string; content: unknown }>;
}

/** Scripted model: each step sees the request context and returns a reply. */
function scripted(steps: ((seen: Seen) => ReturnType<typeof fauxAssistantMessage>)[], opts: { vision?: boolean } = {}) {
	const seen: Seen[] = [];
	const faux = createFauxCore(opts.vision === false ? { models: [{ id: "text-only", input: ["text"] }] } : {});
	faux.setResponses(
		steps.map((step): FauxResponseStep => (context) => {
			// The agent declares its prompt and loadout in leading system messages.
			const system = context.messages.filter((m): m is SystemMessage => m.role === "system");
			const s: Seen = {
				systemPrompt: system
					.flatMap((m) => [typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(""), ...Object.values(m.sections ?? {})])
					.join("\n"),
				tools: system.flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name)),
				messages: context.messages.filter((m) => m.role !== "system") as Seen["messages"],
			};
			seen.push(s);
			return step(s);
		}),
	);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, seen };
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
		fs.rmSync(attachmentsDir(id), { recursive: true, force: true });
	}
});

function newChat(): string {
	const chat = chatStore.createChat("Test: attachments");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat.id;
}

async function upload(chatId: string, name: string, bytes: Uint8Array) {
	const form = new FormData();
	form.append("files", new File([Buffer.from(bytes)], name));
	const res = await attachmentsRoute.POST(new Request(`http://local/api/chats/${chatId}/attachments`, { method: "POST", body: form }), {
		params: Promise.resolve({ id: chatId }),
	});
	assert.equal(res.status, 200);
	const { results } = (await res.json()) as { results: Array<{ ok: boolean; attachment?: AttachmentRecord; error?: string }> };
	return results[0]!;
}

async function attach(chatId: string, name: string, bytes: Uint8Array): Promise<{ record: AttachmentRecord; path: string }> {
	const result = await upload(chatId, name, bytes);
	assert.ok(result.ok, result.error);
	return { record: result.attachment!, path: path.join(attachmentsDir(chatId), result.attachment!.file) };
}

/** Send one learner message and run the turn to completion. */
async function send(chatId: string, engine: PiEngine, text: string, attachmentIds?: string[]): Promise<void> {
	const req = new Request("http://local/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text, ...(attachmentIds ? { attachmentIds } : {}) } }),
	});
	const ack = await handleChatRequest(req, (opts) => createTeacherAgent(undefined, { ...opts, engine }));
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

/** The text of the most recent tool result the model was handed. */
function lastToolResult(s: Seen): string {
	const result = [...s.messages].reverse().find((m) => m.role === "toolResult");
	return ((result?.content ?? []) as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
}

describe("session attachments (upload route → turn)", () => {
	it("lists an attached PDF in the system prompt and reads it page by page, scoped to the session", async () => {
		const chatId = newChat();
		const pdf = await attach(chatId, "physics notes.pdf", PDF);
		assert.equal(pdf.record.pages, 3);

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("pdf_search", { path: pdf.path, query: "force" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("pdf_extract", { path: pdf.path, pages: "2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("pdf_extract", { path: "/etc/passwd", pages: "1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Page 2 covers force.")]),
		]);
		await send(chatId, engine, "explain the force section of my notes");

		assert.match(seen[0]!.systemPrompt, /## Session attachments/);
		assert.match(seen[0]!.systemPrompt, /physics notes\.pdf — PDF, 3 pages/);
		assert.ok(["pdf_info", "pdf_extract", "pdf_search"].every((t) => seen[0]!.tools.includes(t)));
		assert.ok(!seen[0]!.tools.some((t) => t.startsWith("epub_")), "no EPUB attached, no EPUB tools");
		assert.match(lastToolResult(seen[1]!), /"page":2/);
		assert.match(lastToolResult(seen[2]!), /--- Page 2 ---/);
		assert.doesNotMatch(lastToolResult(seen[2]!), /--- Page 1 ---/);
		assert.match(lastToolResult(seen[3]!), /must be one of this session's attachments/);
	});

	it("reads an attached EPUB by structure, chapter slice and search; refuses DRM at upload", async () => {
		const chatId = newChat();
		const book = await attach(
			chatId,
			"mechanics.epub",
			makeEpub({
				title: "Mechanics Primer",
				chapters: [
					{ title: "Cover", body: "<p>Mechanics</p>" },
					{ title: "Kinematics", body: "<h1>Kinematics</h1><p>Velocity is the rate of change of position.</p>" },
					{ title: "Forces", body: "<h1>Forces</h1>" + Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1} on force.</p>`).join("") },
				],
			}),
		);
		const drm = await upload(chatId, "locked.epub", makeEpub({ encrypted: true, chapters: [{ title: "A", body: "<p>x</p>" }] }));
		assert.equal(drm.ok, false);
		assert.match(drm.error!, /DRM/);

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("epub_info", { path: book.path })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("epub_read", { path: book.path, chapter: 3, limit: 4 })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("epub_search", { path: book.path, query: "velocity" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(chatId, engine, "what does my book say about forces?");

		assert.match(seen[0]!.systemPrompt, /mechanics\.epub — EPUB "Mechanics Primer", 3 chapters/);
		assert.doesNotMatch(seen[0]!.systemPrompt, /locked\.epub/, "a refused upload is not an attachment");
		assert.match(lastToolResult(seen[1]!), /Kinematics/);
		const chapter = lastToolResult(seen[2]!);
		assert.match(chapter, /# Forces/);
		assert.doesNotMatch(chapter, /Velocity/);
		assert.match(chapter, /Use offset=5 to continue/);
		assert.match(lastToolResult(seen[3]!), /ch 2 \(Kinematics/);
	});

	it("shows an attached image to a vision model on its message, without storing the bytes in the record", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const { engine, seen } = scripted([() => fauxAssistantMessage([fauxText("A single pixel.")])]);
		await send(chatId, engine, "what is in this diagram?", [image.record.id]);

		const user = seen[0]!.messages.find((m) => m.role === "user")!;
		assert.ok(Array.isArray(user.content));
		assert.deepEqual((user.content as Array<{ type: string }>).map((p) => p.type), ["text", "image"]);
		const stored = fs.readFileSync(path.join(PATHS.chats, `${chatId}.json`), "utf-8");
		assert.ok(!stored.includes(PNG.toString("base64")), "no image bytes in the chat record");
		assert.ok(stored.includes(image.record.id), "the message keeps the attachment id");
	});

	it("keeps a text-only model working: the image is named in the manifest, not sent", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const { engine, seen } = scripted([() => fauxAssistantMessage([fauxText("I can't see images.")])], { vision: false });
		await send(chatId, engine, "what is in this diagram?", [image.record.id]);

		assert.equal(seen[0]!.messages.find((m) => m.role === "user")!.content, "what is in this diagram?");
		assert.match(seen[0]!.systemPrompt, /diagram\.png — image/);
	});

	it("rejects a message naming an attachment the session doesn't have", async () => {
		const chatId = newChat();
		const req = new Request("http://local/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "hi", attachmentIds: ["att_nope"] } }),
		});
		const res = await handleChatRequest(req, () => assert.fail("no turn should run"));
		assert.equal(res.status, 400);
	});

	it("survives compaction and resume; deleting the session removes its files", async () => {
		const chatId = newChat();
		const image = await attach(chatId, "diagram.png", PNG);
		const book = await attach(chatId, "mechanics.epub", makeEpub({ chapters: [{ title: "Only", body: "<p>x</p>" }] }));
		const first = scripted([() => fauxAssistantMessage([fauxText("Seen.")])]);
		await send(chatId, first.engine, "look at this", [image.record.id]);

		// Compact everything up to the teacher's reply (the image message falls before the cut).
		const record = chatStore.getChat(chatId)!;
		const reply = record.messages.at(-1)!;
		chatStore.saveMessages(chatId, [
			...record.messages,
			newCompactionMarker("The learner shared a diagram.", { firstKeptMessageId: reply.id, tokensBefore: 1000, at: new Date().toISOString() }),
		]);

		const second = scripted([() => fauxAssistantMessage([fauxText("Continuing.")])]);
		await send(chatId, second.engine, "continue");
		const ctx = second.seen[0]!;
		assert.match(ctx.systemPrompt, /diagram\.png — image/);
		assert.match(ctx.systemPrompt, /mechanics\.epub — EPUB/);
		assert.ok(ctx.tools.includes("epub_read"));
		assert.ok(
			!JSON.stringify(ctx.messages).includes(PNG.toString("base64")),
			"a compacted-away message does not re-inject its image",
		);

		assert.ok(fs.existsSync(book.path));
		const outcome = await deleteChatSession(chatId, "preserve-graph");
		assert.ok(outcome.ok);
		assert.equal(fs.existsSync(attachmentsDir(chatId)), false);
	});
});
