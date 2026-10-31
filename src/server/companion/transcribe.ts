/**
 * Notebook transcription for the iPad's "Answer from notebook" flow: the
 * VISION slot reads the selected pages and returns the learner's words as
 * plain text, which the learner checks and edits on the iPad before it is
 * sent. (Ordinary answers never transcribe — the teacher reads the images
 * directly.)
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../../agent/models.ts";
import { runSubagent } from "../../agent/subagents/pi-run.ts";
import type { NotebookAttachment } from "../../core/contracts/notebook.ts";
import { providerKeyPresent } from "../keys.ts";
import { effectiveSettings, stores } from "../stores.ts";

export const TRANSCRIBE_SYSTEM_PROMPT = [
	"You transcribe a learner's handwritten notebook pages into plain text.",
	"Write exactly what the learner wrote, in reading order, preserving their wording, line breaks and lists.",
	"Do not correct, complete, summarize or answer anything.",
	"Write mathematics in LaTeX between $…$ (inline) or $$…$$ (display).",
	"For a sketch, diagram or mind map, write one short bracketed description of its structure, e.g. [diagram: A → B → C].",
	"Mark illegible words as [illegible]. Output only the transcription — no preamble.",
].join("\n");

export class TranscribeError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export async function transcribeNotebook(chatId: string, attachments: NotebookAttachment[]): Promise<string> {
	if (attachments.length === 0) throw new TranscribeError("There is nothing on the selected pages to transcribe.", 400);
	const slot = effectiveSettings().models.vision;
	if (!slot) throw new TranscribeError("Choose a vision model in Settings → Agent → Models to transcribe handwriting.", 503);
	if (!providerKeyPresent(slot.provider)) throw new TranscribeError(`The vision model's provider (${slot.provider}) has no key configured.`, 503);
	const engine = piEngineForSpec(
		{ provider: slot.provider, id: slot.id, thinkingLevel: slot.thinkingLevel },
		true,
		undefined,
		() => stores.settingsStore.readSettings()?.models?.vision?.cacheRetention,
	);
	if (!engine.model.input.includes("image")) {
		throw new TranscribeError("The model in the vision slot cannot read images. Choose an image-capable model.", 503);
	}
	const content: Array<TextContent | ImageContent> = [
		{ type: "text", text: `Transcribe ${attachments.length === 1 ? "this notebook page" : `these ${attachments.length} notebook pages, in order`}.` },
	];
	for (const a of attachments) {
		const bytes = stores.notebookStore.readImage(chatId, a.file);
		if (!bytes) continue;
		if (attachments.length > 1) content.push({ type: "text", text: `Page ${a.pageNumber}:` });
		content.push({ type: "image", data: bytes.toString("base64"), mimeType: a.mimeType });
	}
	const { text } = await runSubagent([], {
		// The role only labels debug captures; the engine is the vision slot.
		role: "pdfReader",
		engine,
		systemPrompt: TRANSCRIBE_SYSTEM_PROMPT,
		messages: [{ role: "user", content, timestamp: Date.now() }],
		maxTurns: 1,
		chatId,
	});
	return text.trim();
}
