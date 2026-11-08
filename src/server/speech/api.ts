/**
 * Read-aloud HTTP surface (speech wave, 2026-11-08). One tutor text →
 * formula references (SRE, local) → spoken script (GPT-6 Luna, streamed)
 * → pieces (SpeechChunker) → audio (gpt-4o-mini-tts, one request per
 * piece, in order) → disk. POST /api/speech streams NDJSON events as each
 * piece lands, so playback starts on the first sentence; a complete cached
 * entry answers instantly and costs nothing ("listen again").
 *
 * A changed voice or instruction does NOT invalidate cached audio (owner
 * decision a, 2026-11-08): only new texts are generated with the new
 * settings, so nothing ever costs money unasked.
 */

import { SPEECH_SCRIPT_MODEL, SPEECH_TTS_MODEL, SpeechChunker, isSpeechKey, isSpeechVoice, speechKey, type SpeechStreamEvent } from "../../core/speech.ts";
import { speechStore, isSpeechPieceFile, type SpeechManifest } from "../../store/speech.ts";
import { providerKeyPresent } from "../keys.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { formulaReferences } from "./math.ts";
import { streamSpeechScript } from "./script.ts";
import { SpeechSynthesisError, synthesizeSpeech } from "./tts.ts";

/** The ceiling for one tutor text (characters). */
export const MAX_SPEECH_TEXT = 40_000;

const NO_KEY = "No OpenAI key — add OPENAI_API_KEY under Settings → Providers to read tutor messages aloud.";

/** Generations in flight, by chat + key: a second request for the same
 *  text must not wipe the entry the first one is writing. */
const inFlight = new Set<string>();

function pieceUrl(chatId: string, key: string, file: string): string {
	return `/api/speech/${encodeURIComponent(chatId)}/${key}/${file}`;
}

function line(event: SpeechStreamEvent): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Test seam: scripted model + synthesis replace the production calls. */
export interface SpeechDeps {
	streamScript?: typeof streamSpeechScript;
	synthesize?: typeof synthesizeSpeech;
}

/** POST /api/speech — body { chatId, text }. */
export async function speechSpeak(request: Request, deps: SpeechDeps = {}): Promise<Response> {
	const streamScript = deps.streamScript ?? streamSpeechScript;
	const synthesize = deps.synthesize ?? synthesizeSpeech;
	const body = (await request.json().catch(() => null)) as { chatId?: unknown; text?: unknown } | null;
	if (body === null || typeof body !== "object") return Response.json({ message: "Invalid JSON body." }, { status: 400 });
	const chatId = typeof body?.chatId === "string" ? body.chatId : "";
	const text = typeof body?.text === "string" ? body.text : "";
	if (!chatId || !stores.chatStore.getChat(chatId)) return Response.json({ message: "No such session." }, { status: 404 });
	if (!text.trim()) return Response.json({ message: "Nothing to read." }, { status: 400 });
	if (text.length > MAX_SPEECH_TEXT) return Response.json({ message: "This message is too long to read aloud." }, { status: 413 });

	const key = speechKey(text);
	const cached = speechStore.getComplete(chatId, key, text);
	if (cached) {
		const events: SpeechStreamEvent[] = [
			...cached.files.map((file, index) => ({ type: "chunk" as const, index, url: pieceUrl(chatId, key, file) })),
			{ type: "done", cached: true },
		];
		return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
			headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
		});
	}
	if (!providerKeyPresent(SPEECH_SCRIPT_MODEL.provider)) return Response.json({ message: NO_KEY }, { status: 503 });
	const flightKey = `${chatId}/${key}`;
	if (inFlight.has(flightKey)) return Response.json({ message: "This message is already being prepared." }, { status: 409 });
	inFlight.add(flightKey);

	const settings = effectiveSettings();
	const { voice, instructions } = settings.speech;
	const abort = new AbortController();
	const onClientGone = () => abort.abort();
	request.signal.addEventListener("abort", onClientGone, { once: true });

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const emit = (event: SpeechStreamEvent) => {
				if (closed) return;
				try {
					controller.enqueue(line(event));
				} catch {
					closed = true;
				}
			};
			const run = async () => {
				const pieces: string[] = [];
				const files: string[] = [];
				// Synthesis runs one piece at a time, in order, while the
				// script keeps streaming — the chain is the order.
				let chain: Promise<void> = Promise.resolve();
				const synth = (piece: string) => {
					const index = pieces.length;
					pieces.push(piece);
					chain = chain.then(async () => {
						const audio = await synthesize(piece, voice, instructions, abort.signal);
						const file = speechStore.writePiece(chatId, key, index, audio);
						files[index] = file;
						emit({ type: "chunk", index, url: pieceUrl(chatId, key, file) });
					});
					// A failed piece stops the script too (no paying for text
					// that can no longer be spoken in order).
					chain.catch(() => abort.abort());
				};
				try {
					const references = await formulaReferences(text, settings.dictation.language);
					speechStore.begin(chatId, key);
					const chunker = new SpeechChunker();
					for await (const delta of streamScript(text, references, abort.signal)) {
						for (const piece of chunker.push(delta)) synth(piece);
					}
					for (const piece of chunker.flush()) synth(piece);
					await chain;
					if (pieces.length === 0) throw new Error("The script model returned no text.");
					const manifest: SpeechManifest = {
						key,
						text,
						pieces,
						files,
						voice,
						instructions,
						scriptModel: `${SPEECH_SCRIPT_MODEL.provider}/${SPEECH_SCRIPT_MODEL.id}@${SPEECH_SCRIPT_MODEL.thinkingLevel}`,
						ttsModel: SPEECH_TTS_MODEL,
						createdAt: new Date().toISOString(),
					};
					speechStore.commit(chatId, manifest);
					emit({ type: "done", cached: false });
				} catch (error) {
					// The chain's own failure is the real cause when the script
					// stream merely reports the abort it triggered.
					const cause = await chain.then(() => error, (chainError: unknown) => chainError);
					speechStore.discard(chatId, key);
					if (!request.signal.aborted) {
						const message = cause instanceof SpeechSynthesisError || (cause instanceof Error && !isAbort(cause))
							? cause.message
							: "Reading aloud was interrupted.";
						console.warn(`[speech] ${chatId}/${key}: ${message}`);
						emit({ type: "error", message });
					}
				} finally {
					inFlight.delete(flightKey);
					request.signal.removeEventListener("abort", onClientGone);
					if (!closed) {
						closed = true;
						try {
							controller.close();
						} catch {
							// already closed by a cancel
						}
					}
				}
			};
			void run();
		},
		cancel() {
			abort.abort();
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/** GET /api/speech/[chatId] — the keys with complete audio. */
export function speechList(chatId: string): Response {
	try {
		return Response.json({ keys: speechStore.listComplete(chatId) });
	} catch {
		return Response.json({ message: "Invalid session id." }, { status: 400 });
	}
}

/** GET /api/speech/[chatId]/[key]/[file] — one stored piece. */
export function speechPiece(chatId: string, key: string, file: string): Response {
	if (!isSpeechKey(key) || !isSpeechPieceFile(file)) return new Response(null, { status: 400 });
	let audio: Buffer | null;
	try {
		audio = speechStore.readPiece(chatId, key, file);
	} catch {
		return new Response(null, { status: 400 });
	}
	if (!audio) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(audio), {
		headers: { "Content-Type": "audio/mpeg", "Content-Length": String(audio.length), "Cache-Control": "private, max-age=31536000, immutable" },
	});
}

/** The voice-preview sentence (Settings → Read aloud → Listen). */
export const SPEECH_PREVIEW_TEXT =
	"Hallo! So klinge ich, wenn ich dir die Nachrichten deines Tutors vorlese. Zum Beispiel: n über k ist gleich n Fakultät, geteilt durch k Fakultät mal die Fakultät von n minus k.";

/** POST /api/speech/preview — body { voice, instructions }. */
export async function speechPreview(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { voice?: unknown; instructions?: unknown } | null;
	if (!isSpeechVoice(body?.voice)) return Response.json({ message: "Unsupported voice." }, { status: 400 });
	const instructions = typeof body?.instructions === "string" ? body.instructions : "";
	try {
		const audio = await synthesizeSpeech(SPEECH_PREVIEW_TEXT, body.voice, instructions, request.signal);
		return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
	} catch (error) {
		if (isAbort(error)) return new Response(null, { status: 499 });
		const status = error instanceof SpeechSynthesisError ? error.status : 502;
		return Response.json({ message: error instanceof Error ? error.message : "Preview failed." }, { status });
	}
}
