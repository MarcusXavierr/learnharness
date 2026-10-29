import { addChatAttachments, getChat } from "@/src/server";
import { ATTACHMENT_MAX_BYTES } from "@/src/core";

/**
 * POST /api/chats/[id]/attachments — session context attachments
 * (2026-10-29). Multipart field "files" (the notes-import shape); each file
 * is validated, stored once by content (shared blob store), inspected, and
 * recorded on the chat. Per-file results ({requestIndex, ok, attachment |
 * error}) so one bad file never sinks the others. The composer uploads one
 * file per request: proxy.ts buffers bodies up to next.config's
 * proxyClientMaxBodySize, sized for one ATTACHMENT_MAX_BYTES file.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > ATTACHMENT_MAX_BYTES + 1024 * 1024) {
		return Response.json({ error: "Upload is too large — attach one file of at most 50 MB per request." }, { status: 413 });
	}
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return Response.json({ error: "Invalid upload body" }, { status: 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });
	const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
	return Response.json({ results: await addChatAttachments(id, uploads) });
}
