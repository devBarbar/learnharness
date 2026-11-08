/**
 * POST /api/speech — read one tutor text aloud (speech wave, 2026-11-08).
 * Body { chatId, text }; the response streams NDJSON SpeechStreamEvents
 * (core/speech.ts) as each spoken piece is stored. Logic lives in
 * src/server/speech/api.ts.
 */
import { speechSpeak } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return speechSpeak(request);
}
