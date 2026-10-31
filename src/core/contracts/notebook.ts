/**
 * THE iPAD NOTEBOOK CONTRACT (companion feature). A session's notebook is
 * the learner's always-on scratch surface on a paired iPad: ink pages and
 * camera photos. Every learner ANSWER (question answers and practice
 * thinking — never plain composer text) carries the pages that CHANGED
 * since the previous answer, as images the model reads directly.
 *
 * The record stores REFERENCES (NotebookAttachment), never image bytes:
 * the chat JSON and the browser stream stay small, and the bytes are read
 * only at the model-facing seam (toLlmMessages + an injected resolver).
 * Attachment files are immutable per version (`<pageId>-v<version>.<ext>`)
 * so a later edit never rewrites what an earlier answer showed the model.
 *
 * Pure: no IO. The fs adapter lives in src/store/notebooks.ts.
 */

export type NotebookPageKind = "ink" | "photo";

/** One stored page (the notebook.json entry). */
export interface NotebookPage {
	id: string;
	kind: NotebookPageKind;
	/** Bumped on every saved change; 0 = never saved (an empty new page). */
	version: number;
	/** The version last attached to an answer (0 = never sent). */
	sentVersion: number;
	/** Whether the page has any visible content (blank ink pages are never sent). */
	hasContent: boolean;
	/** Snapshot image extension of the CURRENT version. */
	ext: "png" | "jpg";
	updatedAt: string;
}

export interface NotebookRecord {
	chatId: string;
	pages: NotebookPage[];
}

/** What an answer's record carries per attached page. */
export interface NotebookAttachment {
	pageId: string;
	/** 1-based position in the notebook when it was sent (labels only). */
	pageNumber: number;
	kind: NotebookPageKind;
	version: number;
	/** `<pageId>-v<version>.<ext>` — validated by isNotebookFileName. */
	file: string;
	mimeType: "image/png" | "image/jpeg";
}

/** Image bytes as the provider wire wants them (pi's ImageContent shape). */
export interface NotebookImage {
	data: string;
	mimeType: string;
}

/** How many of the most recent attachment-carrying answers keep their
 *  images in the model context (owner-approved plan, 2026-10-31). Older
 *  ones become a one-line placeholder — the files stay on disk and in the
 *  desktop transcript. */
export const NOTEBOOK_IMAGE_WINDOW = 3;

const PAGE_ID = /^pg_[A-Za-z0-9]{6,32}$/;
const FILE_NAME = /^pg_[A-Za-z0-9]{6,32}-v[1-9][0-9]{0,6}\.(png|jpg)$/;

export function isNotebookPageId(id: unknown): id is string {
	return typeof id === "string" && PAGE_ID.test(id);
}

/** The ONLY accepted attachment file shape — no separators, no traversal. */
export function isNotebookFileName(name: unknown): name is string {
	return typeof name === "string" && FILE_NAME.test(name);
}

export function notebookFileName(pageId: string, version: number, ext: "png" | "jpg"): string {
	return `${pageId}-v${version}.${ext}`;
}

/** The pages an answer should carry: changed since their last send, and
 *  not blank. Notebook order is kept; pageNumber is the 1-based position. */
export function changedPageAttachments(notebook: NotebookRecord | null): NotebookAttachment[] {
	if (!notebook) return [];
	const out: NotebookAttachment[] = [];
	notebook.pages.forEach((page, i) => {
		if (!page.hasContent || page.version <= page.sentVersion) return;
		out.push({
			pageId: page.id,
			pageNumber: i + 1,
			kind: page.kind,
			version: page.version,
			file: notebookFileName(page.id, page.version, page.ext),
			mimeType: page.ext === "png" ? "image/png" : "image/jpeg",
		});
	});
	return out;
}

/** Validate attachments read back from a record (foreign/old/tampered
 *  records degrade to omission — never a crash, never a stray path). */
export function validNotebookAttachments(value: unknown): NotebookAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.filter((a): a is NotebookAttachment =>
		typeof a === "object" && a !== null &&
		isNotebookPageId((a as NotebookAttachment).pageId) &&
		isNotebookFileName((a as NotebookAttachment).file) &&
		((a as NotebookAttachment).kind === "ink" || (a as NotebookAttachment).kind === "photo") &&
		((a as NotebookAttachment).mimeType === "image/png" || (a as NotebookAttachment).mimeType === "image/jpeg") &&
		Number.isSafeInteger((a as NotebookAttachment).pageNumber) &&
		Number.isSafeInteger((a as NotebookAttachment).version),
	);
}

/** The model-facing label that precedes each image. */
export function notebookPageLabel(a: NotebookAttachment): string {
	return a.kind === "photo"
		? `The learner's notebook — page ${a.pageNumber} (photo of paper notes), new or changed since their last answer:`
		: `The learner's iPad notebook — page ${a.pageNumber} (handwriting/sketch), new or changed since their last answer:`;
}

/** The placeholder for an attachment outside the image window. */
export function notebookPlaceholder(attachments: NotebookAttachment[]): string {
	const pages = attachments.map((a) => a.pageNumber).join(", ");
	return `[The learner's notebook page${attachments.length === 1 ? "" : "s"} ${pages} ${attachments.length === 1 ? "was" : "were"} attached to this answer; the image${attachments.length === 1 ? " is" : "s are"} omitted here to save context.]`;
}

/** The placeholder when the conversation model cannot read images. */
export function notebookNoVisionNote(attachments: NotebookAttachment[]): string {
	return `[The learner attached ${attachments.length} notebook page image${attachments.length === 1 ? "" : "s"} to this answer, but the current model cannot read images, so they were not sent.]`;
}
