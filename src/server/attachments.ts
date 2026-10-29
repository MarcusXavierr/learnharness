import * as crypto from "node:crypto";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_TYPES,
	attachmentExtension,
	type AttachmentRecord,
} from "../core/contracts.ts";
import { epubInfo } from "../agent/subagents/epub-ops.ts";
import { pdfInfo } from "../agent/subagents/pdf-ops.ts";
import { attachmentPath, removeAttachmentFile, writeAttachmentFile } from "../store/attachments.ts";
import { stores } from "./stores.ts";

/**
 * Session context attachments (2026-10-29) — the upload orchestration
 * behind POST /api/chats/[id]/attachments. Each file is validated (type,
 * size), copied into the chat's attachments dir, and INSPECTED once (PDF
 * page count, EPUB chapters + title — which also refuses DRM and broken
 * files at the door, never mid-lesson); only then does its record land on
 * the chat. Per-file outcomes, notes-import style: one bad file never
 * sinks the others.
 */

export interface UploadedFile {
	name: string;
	bytes: Uint8Array;
}

export type AttachmentUploadResult =
	| { requestIndex: number; name: string; ok: true; attachment: AttachmentRecord }
	| { requestIndex: number; name: string; ok: false; error: string };

function formatMb(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function inspect(path: string, kind: AttachmentRecord["kind"]): Promise<Partial<AttachmentRecord>> {
	if (kind === "pdf") {
		const info = await pdfInfo(path).catch(() => {
			throw new Error("This PDF can't be opened (damaged or password-protected).");
		});
		return { pages: info.page_count };
	}
	if (kind === "epub") {
		const info = await epubInfo(path);
		return { chapters: info.chapters.length, title: info.title };
	}
	return {};
}

export async function addChatAttachments(chatId: string, files: UploadedFile[]): Promise<AttachmentUploadResult[]> {
	const results: AttachmentUploadResult[] = [];
	const accepted: AttachmentRecord[] = [];
	for (const [requestIndex, { name, bytes }] of files.entries()) {
		const ext = attachmentExtension(name);
		const type = ATTACHMENT_TYPES[ext];
		if (!type) {
			results.push({ requestIndex, name, ok: false, error: "Unsupported file type. Attach images (PNG, JPG, GIF, WebP), PDFs, or EPUBs." });
			continue;
		}
		if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
			results.push({ requestIndex, name, ok: false, error: `File is larger than ${formatMb(ATTACHMENT_MAX_BYTES)}.` });
			continue;
		}
		const id = `att_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const file = writeAttachmentFile(chatId, id, ext, bytes);
		try {
			const facts = await inspect(attachmentPath(chatId, { file }), type.kind);
			const attachment: AttachmentRecord = {
				id,
				name,
				kind: type.kind,
				mimeType: type.mimeType,
				bytes: bytes.byteLength,
				file,
				addedAt: new Date().toISOString(),
				...facts,
			};
			accepted.push(attachment);
			results.push({ requestIndex, name, ok: true, attachment });
		} catch (err) {
			removeAttachmentFile(chatId, file);
			results.push({ requestIndex, name, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	if (accepted.length > 0) stores.chatStore.addAttachments(chatId, accepted);
	return results;
}
