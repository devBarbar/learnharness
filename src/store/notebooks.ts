/**
 * NotebookStore — the fs adapter for iPad companion notebooks (one
 * directory per chat under data/notebooks/<chatId>/):
 *
 *   notebook.json               page list + versions (NotebookRecord)
 *   <pageId>.strokes.json       the CURRENT ink vector state (iPad reload)
 *   <pageId>-v<version>.<ext>   immutable rendered snapshot per version
 *
 * A snapshot that was attached to an answer is never rewritten or deleted
 * by a later edit (the answer's record names it). Superseded snapshots
 * that were never sent are pruned on the next save. Same idioms as the
 * chat store: sync fs, id-guarded paths, tab-indented JSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	isNotebookFileName,
	isNotebookPageId,
	notebookFileName,
	type NotebookAttachment,
	type NotebookPage,
	type NotebookPageKind,
	type NotebookRecord,
} from "../core/contracts/notebook.ts";

/** One rendered snapshot's size ceiling (decoded bytes). */
export const MAX_NOTEBOOK_IMAGE_BYTES = 8 * 1024 * 1024;
/** One page's stroke-state ceiling (bytes of JSON). */
export const MAX_NOTEBOOK_STROKES_BYTES = 4 * 1024 * 1024;
/** Pages per notebook. */
export const MAX_NOTEBOOK_PAGES = 100;

const CHAT_ID = /^[A-Za-z0-9_-]+$/;

export class NotebookStoreError extends Error {}

function root(): string {
	return path.join(PATHS.data, "notebooks");
}

function chatDir(chatId: string): string {
	if (!CHAT_ID.test(chatId)) throw new NotebookStoreError(`Invalid chat id: ${chatId}`);
	return path.join(root(), chatId);
}

function recordFile(chatId: string): string {
	return path.join(chatDir(chatId), "notebook.json");
}

function strokesFile(chatId: string, pageId: string): string {
	if (!isNotebookPageId(pageId)) throw new NotebookStoreError(`Invalid page id: ${pageId}`);
	return path.join(chatDir(chatId), `${pageId}.strokes.json`);
}

function imageFile(chatId: string, file: string): string {
	if (!isNotebookFileName(file)) throw new NotebookStoreError(`Invalid notebook file: ${file}`);
	return path.join(chatDir(chatId), file);
}

function writeAtomic(file: string, data: string | Buffer): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function read(chatId: string): NotebookRecord | null {
	let raw: string;
	try {
		raw = fs.readFileSync(recordFile(chatId), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const parsed = JSON.parse(raw) as NotebookRecord;
	return {
		chatId,
		pages: Array.isArray(parsed.pages) ? parsed.pages.filter((p) => isNotebookPageId(p?.id)) : [],
	};
}

function write(record: NotebookRecord): void {
	fs.mkdirSync(chatDir(record.chatId), { recursive: true });
	writeAtomic(recordFile(record.chatId), JSON.stringify(record, null, "\t"));
}

export interface SavePageInput {
	pageId: string;
	kind: NotebookPageKind;
	hasContent: boolean;
	image: Buffer;
	ext: "png" | "jpg";
	/** Ink only: the vector state the iPad reloads. */
	strokes?: string;
	/** Optimistic concurrency: the version the client last saw (absent = new page). */
	baseVersion?: number;
}

/** Save a page's new state: bumps the version, writes the snapshot, prunes
 *  the superseded never-sent snapshot. A page that does not exist yet is
 *  appended. Returns the updated page. */
function savePage(chatId: string, input: SavePageInput): NotebookPage {
	if (!isNotebookPageId(input.pageId)) throw new NotebookStoreError(`Invalid page id: ${input.pageId}`);
	if (input.image.length === 0 || input.image.length > MAX_NOTEBOOK_IMAGE_BYTES) {
		throw new NotebookStoreError("Notebook image is empty or too large.");
	}
	if (input.strokes !== undefined && Buffer.byteLength(input.strokes) > MAX_NOTEBOOK_STROKES_BYTES) {
		throw new NotebookStoreError("Notebook page is too large.");
	}
	const record = read(chatId) ?? { chatId, pages: [] };
	let page = record.pages.find((p) => p.id === input.pageId);
	if (!page) {
		if (record.pages.length >= MAX_NOTEBOOK_PAGES) throw new NotebookStoreError("This notebook has too many pages.");
		page = { id: input.pageId, kind: input.kind, version: 0, sentVersion: 0, hasContent: false, ext: input.ext, updatedAt: "" };
		record.pages.push(page);
	} else if (page.kind !== input.kind) {
		throw new NotebookStoreError("A page cannot change kind.");
	}
	const previous = { version: page.version, ext: page.ext };
	page.version += 1;
	page.ext = input.ext;
	page.hasContent = input.hasContent;
	page.updatedAt = new Date().toISOString();
	fs.mkdirSync(chatDir(chatId), { recursive: true });
	writeAtomic(imageFile(chatId, notebookFileName(page.id, page.version, page.ext)), input.image);
	if (input.strokes !== undefined) writeAtomic(strokesFile(chatId, page.id), input.strokes);
	write(record);
	// The superseded snapshot goes only if no answer ever referenced it.
	if (previous.version > 0 && previous.version > page.sentVersion) {
		try { fs.unlinkSync(imageFile(chatId, notebookFileName(page.id, previous.version, previous.ext))); }
		catch { /* already gone */ }
	}
	return { ...page };
}

/** Remove a page from the notebook. Snapshots an answer referenced stay. */
function deletePage(chatId: string, pageId: string): boolean {
	const record = read(chatId);
	const page = record?.pages.find((p) => p.id === pageId);
	if (!record || !page) return false;
	record.pages = record.pages.filter((p) => p.id !== pageId);
	write(record);
	if (page.version > page.sentVersion) {
		try { fs.unlinkSync(imageFile(chatId, notebookFileName(page.id, page.version, page.ext))); }
		catch { /* already gone */ }
	}
	try { fs.unlinkSync(strokesFile(chatId, pageId)); }
	catch { /* photo pages have none */ }
	return true;
}

function readStrokes(chatId: string, pageId: string): string | null {
	try {
		return fs.readFileSync(strokesFile(chatId, pageId), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

function readImage(chatId: string, file: string): Buffer | null {
	try {
		return fs.readFileSync(imageFile(chatId, file));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** Record that these versions were attached to an answer: they are no
 *  longer "changed", and their snapshots become permanent. */
function markSent(chatId: string, attachments: readonly NotebookAttachment[]): void {
	if (attachments.length === 0) return;
	const record = read(chatId);
	if (!record) return;
	for (const a of attachments) {
		const page = record.pages.find((p) => p.id === a.pageId);
		if (page && a.version > page.sentVersion) page.sentVersion = a.version;
	}
	write(record);
}

export const notebookStore = { read, savePage, deletePage, readStrokes, readImage, markSent };
export type NotebookStore = typeof notebookStore;
