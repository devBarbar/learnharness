/**
 * One synthesis request to OpenAI's speech endpoint (speech wave,
 * 2026-11-08): gpt-4o-mini-tts, MP3. The key stays server-side; tempo is
 * NOT sent — it is applied at playback (core/speech.ts).
 */

import { SPEECH_TTS_MODEL } from "../../core/speech.ts";
import { keyValue } from "../keys.ts";

export class SpeechSynthesisError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export async function synthesizeSpeech(
	input: string,
	voice: string,
	instructions: string,
	signal?: AbortSignal,
): Promise<Buffer> {
	const key = keyValue("OPENAI_API_KEY");
	if (!key) throw new SpeechSynthesisError("No OpenAI key — add OPENAI_API_KEY under Settings → Providers.", 503);
	const res = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: SPEECH_TTS_MODEL,
			voice,
			input,
			...(instructions.trim() ? { instructions } : {}),
			response_format: "mp3",
		}),
		signal,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new SpeechSynthesisError(`OpenAI speech failed (${res.status}): ${detail.slice(0, 200)}`, 502);
	}
	return Buffer.from(await res.arrayBuffer());
}
