/**
 * The spoken-script rewrite (speech wave, 2026-11-08): GPT-6 Luna at
 * reasoning low turns one tutor text (Markdown + LaTeX) into natural
 * spoken text, streamed, so synthesis can start on the first sentence.
 * The system prompt is the owner-approved wording, verbatim (revised
 * 2026-11-08 after the live probe: the first wording made Luna copy the
 * MathSpeak references word for word — "Anfang Bruch … Ende Bruch").
 */

import { normalizeContext } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../../agent/models.ts";
import { SPEECH_SCRIPT_MODEL } from "../../core/speech.ts";
import { keyValue } from "../keys.ts";
import type { FormulaReference } from "./math.ts";

export const SPEECH_SCRIPT_SYSTEM_PROMPT = [
	"Schreibe die Tutor-Nachricht als Sprechtext zum Vorlesen um, in derselben Sprache wie die Nachricht.",
	"Inhalt exakt beibehalten: nichts hinzufügen, nichts weglassen, nichts korrigieren.",
	"Sprich jede Formel so aus, wie ein Mathe-Lehrer sie natürlich vorliest.",
	"Zu jeder Formel bekommst du eine maschinelle Referenz-Lesart. Sie klingt absichtlich steif: Nutze sie nur, um die Struktur zu verstehen, und übernimm nie ihren Wortlaut (keine Wörter wie „Anfang Bruch“, „Ende Bruch“, „großes A“, „Klammer auf“).",
	"Formuliere Klammerung, Bruchgrenzen und Exponenten so, dass man sie beim Hören eindeutig versteht, z. B. „die Fakultät von n minus k“ statt „n minus k Fakultät“.",
	"Keine Markdown-Zeichen, kein LaTeX.",
	"Tabellen als kurze Sätze; Codeblöcke und Diagramme nur kurz erwähnen.",
	"Gib nur den Sprechtext aus.",
].join("\n");

/** The user turn: the message, then one reference line per formula. */
export function speechScriptInput(text: string, references: readonly FormulaReference[]): string {
	const lines = [`Tutor-Nachricht:\n"""\n${text}\n"""`];
	const read = references.filter((r) => r.reading);
	if (read.length > 0) {
		lines.push(
			"Referenz-Lesarten der Formeln:",
			...read.map((r, i) => `${i + 1}. ${r.display ? `$$${r.tex}$$` : `$${r.tex}$`} → ${r.reading}`),
		);
	}
	return lines.join("\n\n");
}

/** Stream the script's text deltas. Throws on provider failure; an abort
 *  throws an AbortError. */
export async function* streamSpeechScript(
	text: string,
	references: readonly FormulaReference[],
	signal: AbortSignal,
): AsyncGenerator<string> {
	const engine = piEngineForSpec({ ...SPEECH_SCRIPT_MODEL }, false);
	// The key rides explicitly — the same keyValue read the synthesis half
	// uses, so script and voice can never run on different OpenAI keys.
	const apiKey = keyValue("OPENAI_API_KEY");
	if (!apiKey) throw new Error("No OpenAI key — add OPENAI_API_KEY under Settings → Providers.");
	const stream = engine.streamFn(
		engine.model,
		normalizeContext({
			systemPrompt: SPEECH_SCRIPT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: speechScriptInput(text, references) }], timestamp: Date.now() }],
		}),
		{ signal, apiKey } as never,
	);
	for await (const event of stream) {
		if (event.type === "text_delta") yield event.delta;
		else if (event.type === "done") return;
		else if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the script model call failed");
		}
	}
}
