/**
 * Attachment files — the fs adapter for session context attachments
 * (2026-10-29). One directory per chat under data/attachments/<chatId>/;
 * the records live on the chat (chatStore.addAttachments), the bytes here.
 * Stored names are `<attachmentId><ext>` — the learner's original name
 * rides the record only, so no learner-chosen string ever becomes a path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AttachmentRecord } from "../core/contracts.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The chat's attachments directory (may not exist yet). */
export function attachmentsDir(chatId: string): string {
	if (!ID_PATTERN.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.attachments, chatId);
}

/** Absolute path of one stored attachment. */
export function attachmentPath(chatId: string, attachment: Pick<AttachmentRecord, "file">): string {
	return path.join(attachmentsDir(chatId), attachment.file);
}

/** Write the bytes; returns the stored file name. */
export function writeAttachmentFile(chatId: string, id: string, ext: string, bytes: Uint8Array): string {
	if (!ID_PATTERN.test(id) || !/^\.[a-z0-9]+$/.test(ext)) throw new Error(`Invalid attachment name: ${id}${ext}`);
	const dir = attachmentsDir(chatId);
	fs.mkdirSync(dir, { recursive: true });
	const file = `${id}${ext}`;
	fs.writeFileSync(path.join(dir, file), bytes);
	return file;
}

/** Remove one stored file (a rejected upload's cleanup). */
export function removeAttachmentFile(chatId: string, file: string): void {
	fs.rmSync(path.join(attachmentsDir(chatId), path.basename(file)), { force: true });
}

/** Remove the chat's whole attachments directory (session deletion). */
export function deleteAttachmentsDir(chatId: string): void {
	fs.rmSync(attachmentsDir(chatId), { recursive: true, force: true });
}
