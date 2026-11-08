/**
 * SpeechStore — the fs adapter for read-aloud audio (speech wave,
 * 2026-11-08). One directory per chat under data/speech/<chatId>/, one
 * subdirectory per spoken tutor text (keyed by core/speech.ts speechKey):
 *
 *   <key>/manifest.json   script, chunk files, voice/instruction/model used
 *   <key>/<n>.mp3         the n-th synthesized piece, in playback order
 *
 * A manifest is written only once every piece is on disk — an entry
 * without one is an interrupted generation and is discarded on the next
 * attempt. Same idioms as the notebook store: sync fs, id-guarded paths,
 * tab-indented JSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { isSpeechKey } from "../core/speech.ts";

export interface SpeechManifest {
	key: string;
	/** The tutor text as rendered (what the key hashes). */
	text: string;
	/** The rewritten spoken script, piece by piece. */
	pieces: string[];
	/** Audio files, parallel to pieces. */
	files: string[];
	voice: string;
	instructions: string;
	scriptModel: string;
	ttsModel: string;
	createdAt: string;
}

const CHAT_ID = /^[A-Za-z0-9_-]+$/;
const PIECE_FILE = /^\d{1,4}\.mp3$/;

export class SpeechStoreError extends Error {}

export function isSpeechPieceFile(file: unknown): file is string {
	return typeof file === "string" && PIECE_FILE.test(file);
}

export function speechPieceFile(index: number): string {
	return `${index}.mp3`;
}

function root(): string {
	return path.join(PATHS.data, "speech");
}

function chatDir(chatId: string): string {
	if (!CHAT_ID.test(chatId)) throw new SpeechStoreError(`Invalid chat id: ${chatId}`);
	return path.join(root(), chatId);
}

function entryDir(chatId: string, key: string): string {
	if (!isSpeechKey(key)) throw new SpeechStoreError(`Invalid speech key: ${key}`);
	return path.join(chatDir(chatId), key);
}

function readManifest(chatId: string, key: string): SpeechManifest | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(entryDir(chatId, key), "manifest.json"), "utf8")) as SpeechManifest;
		return raw && raw.key === key && Array.isArray(raw.files) ? raw : null;
	} catch {
		return null;
	}
}

/** The complete entry for `text`, or null (none, or interrupted). */
function getComplete(chatId: string, key: string, text: string): SpeechManifest | null {
	const manifest = readManifest(chatId, key);
	return manifest && manifest.text === text ? manifest : null;
}

/** Keys with a complete entry in this chat (the "listen again" set). */
function listComplete(chatId: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(chatDir(chatId));
	} catch {
		return [];
	}
	return names.filter((name) => isSpeechKey(name) && readManifest(chatId, name) !== null);
}

/** Start a fresh entry: any previous (interrupted or stale) one is removed. */
function begin(chatId: string, key: string): void {
	const dir = entryDir(chatId, key);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
}

function writePiece(chatId: string, key: string, index: number, audio: Buffer): string {
	const file = speechPieceFile(index);
	fs.writeFileSync(path.join(entryDir(chatId, key), file), audio);
	return file;
}

function commit(chatId: string, manifest: SpeechManifest): void {
	const dir = entryDir(chatId, manifest.key);
	const tmp = path.join(dir, "manifest.json.tmp");
	fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, "\t")}\n`);
	fs.renameSync(tmp, path.join(dir, "manifest.json"));
}

/** Drop an interrupted entry (aborted or failed generation). */
function discard(chatId: string, key: string): void {
	fs.rmSync(entryDir(chatId, key), { recursive: true, force: true });
}

function readPiece(chatId: string, key: string, file: string): Buffer | null {
	if (!isSpeechPieceFile(file)) throw new SpeechStoreError(`Invalid speech file: ${file}`);
	try {
		return fs.readFileSync(path.join(entryDir(chatId, key), file));
	} catch {
		return null;
	}
}

/** Chat deletion: every spoken entry goes with the session. */
function deleteChat(chatId: string): void {
	fs.rmSync(chatDir(chatId), { recursive: true, force: true });
}

export const speechStore = {
	getComplete,
	listComplete,
	begin,
	writePiece,
	commit,
	discard,
	readPiece,
	deleteChat,
};

export type SpeechStore = typeof speechStore;
