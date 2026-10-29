"use client";

import { useRef, useState } from "react";
import { PaperclipIcon, XIcon } from "lucide-react";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, attachmentExtension, type AttachmentRecord } from "@/src/core";

/**
 * Session context attachments (2026-10-29) — the composer side. Picked
 * files wait as chips in the composer and upload ON SEND, one file per
 * request (the API proxy buffers one ATTACHMENT_MAX_BYTES body). A file
 * that uploaded keeps its id, so a retried send never uploads it twice.
 */

export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(",");

interface DraftFile {
	key: string;
	file: File;
	/** Set once the file is on the server. */
	id?: string;
}

/** Upload one file to the chat; the server's per-file result, or a thrown
 *  Error carrying a learner-readable reason. */
export async function uploadAttachment(chatId: string, file: File, fetchLike: typeof fetch): Promise<AttachmentRecord> {
	const form = new FormData();
	form.append("files", file);
	const res = await fetchLike(`/api/chats/${chatId}/attachments`, { method: "POST", body: form });
	const body = (await res.json().catch(() => null)) as
		| { results?: Array<{ ok: boolean; attachment?: AttachmentRecord; error?: string }>; error?: string }
		| null;
	const result = body?.results?.[0];
	if (!res.ok || !result) throw new Error(`${file.name}: ${body?.error ?? `upload failed (HTTP ${res.status})`}`);
	if (!result.ok || !result.attachment) throw new Error(`${file.name}: ${result.error ?? "upload failed"}`);
	return result.attachment;
}

/** Client-side precheck — the server validates again. */
function precheck(file: File): string | null {
	if (!ATTACHMENT_TYPES[attachmentExtension(file.name)]) return `${file.name}: unsupported type. Attach images, PDFs, or EPUBs.`;
	if (file.size > ATTACHMENT_MAX_BYTES) return `${file.name}: larger than 50 MB.`;
	return null;
}

export interface AttachmentDraft {
	files: readonly DraftFile[];
	error: string | null;
	add(list: FileList | null): void;
	remove(key: string): void;
	clear(): void;
	/** Upload every pending file to the chat (in order); the ids of all
	 *  draft files. Throws on the first failure — earlier uploads keep their
	 *  ids for the retry. */
	upload(chatId: string, fetchLike?: typeof fetch): Promise<string[]>;
	/** A stable fingerprint of the picked set (retry identity). */
	identity(): string;
}

export function useAttachmentDraft(onUploaded?: (records: AttachmentRecord[]) => void): AttachmentDraft {
	const [files, setFiles] = useState<DraftFile[]>([]);
	const [error, setError] = useState<string | null>(null);
	// The mirror: upload() runs across renders and must see every id it set.
	const filesRef = useRef<DraftFile[]>([]);
	const write = (next: DraftFile[]) => {
		filesRef.current = next;
		setFiles(next);
	};
	return {
		files,
		error,
		add(list) {
			if (!list) return;
			const problems: string[] = [];
			const added: DraftFile[] = [];
			for (const file of Array.from(list)) {
				const problem = precheck(file);
				if (problem) problems.push(problem);
				else added.push({ key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`, file });
			}
			setError(problems.length ? problems.join("\n") : null);
			write([...filesRef.current, ...added]);
		},
		remove(key) {
			write(filesRef.current.filter((f) => f.key !== key));
			setError(null);
		},
		clear() {
			write([]);
			setError(null);
		},
		async upload(chatId, fetchLike = fetch) {
			setError(null);
			const uploaded: AttachmentRecord[] = [];
			try {
				for (const entry of filesRef.current) {
					if (entry.id) continue;
					const record = await uploadAttachment(chatId, entry.file, fetchLike);
					uploaded.push(record);
					write(filesRef.current.map((f) => (f.key === entry.key ? { ...f, id: record.id } : f)));
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				throw err;
			} finally {
				if (uploaded.length) onUploaded?.(uploaded);
			}
			return filesRef.current.map((f) => f.id!);
		},
		identity() {
			return filesRef.current.map((f) => f.key).join("|");
		},
	};
}

function Chip({ name, onRemove }: { name: string; onRemove?: () => void }) {
	return (
		<span
			data-testid="attachment-chip"
			className="flex max-w-56 items-center gap-1 rounded-full border border-border bg-card py-1 pr-1.5 pl-2.5 font-ui text-xs text-foreground"
		>
			<PaperclipIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
			<span className="truncate">{name}</span>
			{onRemove && (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="cursor-pointer rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon aria-hidden="true" className="size-3" />
				</button>
			)}
		</span>
	);
}

/** The composer's 📎 control: the picker button plus the pending chips. */
export function ContextAttachControl({ draft, disabled }: { draft: AttachmentDraft; disabled?: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={inputRef}
				type="file"
				multiple
				accept={ATTACHMENT_ACCEPT}
				className="hidden"
				data-testid="attachment-input"
				onChange={(e) => {
					draft.add(e.target.files);
					e.target.value = ""; // allow re-picking the same file
				}}
			/>
			<button
				type="button"
				data-testid="attach-context"
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border/80 bg-transparent px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
				}
			>
				<PaperclipIcon aria-hidden="true" className="size-3.5" />
				Add context
			</button>
			{draft.files.map((f) => (
				<Chip key={f.key} name={f.file.name} onRemove={disabled ? undefined : () => draft.remove(f.key)} />
			))}
			{draft.error && (
				<p role="alert" className="w-full whitespace-pre-wrap break-words text-xs text-destructive">
					{draft.error}
				</p>
			)}
		</>
	);
}

/** The transcript's record of what rode a message. */
export function AttachmentChips({ names }: { names: readonly string[] }) {
	if (names.length === 0) return null;
	return (
		<div data-testid="message-attachments" className="mt-1.5 flex flex-wrap gap-1.5">
			{names.map((name, i) => (
				<Chip key={`${name}-${i}`} name={name} />
			))}
		</div>
	);
}
