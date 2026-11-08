/**
 * Read-aloud (speech wave, 2026-11-08) — the PURE, browser-safe half:
 * the voice catalog, the settings bounds, the cache key both sides agree
 * on, and the streaming chunker that turns the rewritten script into
 * speakable pieces.
 *
 * Owner decisions (2026-11-08): tutor messages are rewritten into natural
 * spoken text by GPT-6 Luna (reasoning low) with SRE MathSpeak readings as
 * the structural reference for every formula, then spoken by OpenAI's
 * gpt-4o-mini-tts. Reading is automatic only (a settings switch, default
 * off); voice, tempo and the speaking instruction are user-settable.
 */

/** gpt-4o-mini-tts's built-in voices (OpenAI text-to-speech guide). */
export const SPEECH_VOICES = [
	"marin",
	"cedar",
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"fable",
	"nova",
	"onyx",
	"sage",
	"shimmer",
	"verse",
] as const;

export type SpeechVoice = (typeof SPEECH_VOICES)[number];

export function isSpeechVoice(value: unknown): value is SpeechVoice {
	return typeof value === "string" && (SPEECH_VOICES as readonly string[]).includes(value);
}

/** Tempo is applied at PLAYBACK (the audio element's playbackRate), so a
 *  change also applies to cached audio and never costs a regeneration. */
export const SPEECH_SPEED_MIN = 0.5;
export const SPEECH_SPEED_MAX = 2;

/** The speaking instruction's ceiling (characters). */
export const SPEECH_INSTRUCTIONS_MAX = 2000;

/** The factory speaking instruction — the "vibe" the owner tested on openai.fm. */
export const DEFAULT_SPEECH_INSTRUCTIONS = [
	"Sprache: Deutsch. Rolle: geduldiger, freundlicher Mathe-Tutor.",
	"Tempo: ruhig, etwas langsamer als normal, kurze Pausen vor und nach Formeln.",
	"Betonung: Zahlen und Fachbegriffe wie „Fakultät“ und „Binomialkoeffizient“ deutlich aussprechen.",
	"Ton: ermutigend, aber nicht übertrieben.",
].join("\n");

/** The models (owner decisions 2026-11-08). */
export const SPEECH_SCRIPT_MODEL = { provider: "openai", id: "gpt-6-luna", thinkingLevel: "low" } as const;
export const SPEECH_TTS_MODEL = "gpt-4o-mini-tts";

/**
 * The cache key for one tutor text (53-bit cyrb53, hex). Content-keyed on
 * purpose: live-streamed assistant messages carry client-minted ids that
 * the settle sync replaces with the record's, so a part's view id is not
 * stable — its text is. Identical texts in one chat share their audio.
 */
export function speechKey(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	return `s${text.length.toString(36)}${n.toString(16).padStart(14, "0")}`;
}

export function isSpeechKey(value: unknown): value is string {
	return typeof value === "string" && /^s[0-9a-z]{1,8}[0-9a-f]{14}$/.test(value);
}

/** The first piece is short so the voice starts early; later pieces are
 *  longer (fewer requests, steadier prosody). */
const FIRST_CHUNK_MIN = 40;
const CHUNK_MIN = 220;
const CHUNK_MAX = 900;

/** A sentence end: terminal punctuation (optionally closing quotes or
 *  brackets) followed by whitespace. */
const SENTENCE_END = /[.!?…:;]["“”„»«')\]]*\s/g;

/**
 * The streaming chunker: feed the script's deltas in, take speakable
 * pieces out. A piece ends at a paragraph break, or at a sentence end once
 * it is long enough; a run-on with no sentence end is cut at the last
 * space before CHUNK_MAX. `flush()` returns the remainder at stream end.
 */
export class SpeechChunker {
	private buffer = "";
	private emitted = 0;

	push(delta: string): string[] {
		this.buffer += delta;
		const out: string[] = [];
		for (;;) {
			const piece = this.take();
			if (piece === null) break;
			if (piece.trim()) {
				out.push(piece.trim());
				this.emitted++;
			}
		}
		return out;
	}

	flush(): string[] {
		const rest = this.buffer.trim();
		this.buffer = "";
		if (!rest) return [];
		this.emitted++;
		return [rest];
	}

	private take(): string | null {
		const min = this.emitted === 0 ? FIRST_CHUNK_MIN : CHUNK_MIN;
		const paragraph = this.buffer.search(/\n\s*\n/);
		if (paragraph !== -1 && paragraph >= 1) {
			const piece = this.buffer.slice(0, paragraph);
			// A short paragraph (a heading line) rides with the next one.
			if (piece.trim().length >= min || this.buffer.length > CHUNK_MAX) {
				this.buffer = this.buffer.slice(paragraph).replace(/^\s+/, "");
				return piece;
			}
		}
		SENTENCE_END.lastIndex = 0;
		let cut = -1;
		for (let m = SENTENCE_END.exec(this.buffer); m; m = SENTENCE_END.exec(this.buffer)) {
			const end = m.index + m[0].length;
			if (end > CHUNK_MAX && cut !== -1) break;
			cut = end;
			if (end >= min) break;
		}
		if (cut !== -1 && cut >= min) {
			const piece = this.buffer.slice(0, cut);
			this.buffer = this.buffer.slice(cut);
			return piece;
		}
		if (this.buffer.length > CHUNK_MAX) {
			const space = this.buffer.lastIndexOf(" ", CHUNK_MAX);
			const at = space > min ? space : CHUNK_MAX;
			const piece = this.buffer.slice(0, at);
			this.buffer = this.buffer.slice(at);
			return piece;
		}
		return null;
	}
}

/** One streamed event of POST /api/speech (NDJSON, one per line). */
export type SpeechStreamEvent =
	| { type: "chunk"; index: number; url: string }
	| { type: "done"; cached: boolean }
	| { type: "error"; message: string };
