/**
 * The iPad companion's HTTP handlers (framework-free Request → Response;
 * the app/api/companion routes are one-line wrappers). Access is decided
 * by proxy.ts before any of these run; here a REMOTE caller is further
 * confined to the session the desktop currently shows.
 */

import {
	changedPageAttachments,
	isNotebookFileName,
	isNotebookPageId,
	type NotebookAttachment,
	type NotebookPage,
} from "../../core/contracts/notebook.ts";
import { activeProblemOf, danglingQuestionOf } from "../../core/native-messages.ts";
import { toolQuestionKind } from "../../core/pending.ts";
import { buildAnswer, parseOptionsIfString, questionDataFromCall, type QuizToolInput } from "../../core/question-core.ts";
import { NotebookStoreError } from "../../store/notebooks.ts";
import { handleChatInput } from "../chat-handler.ts";
import { stores } from "../stores.ts";
import { isTurnRunning } from "../turn-liveness.ts";
import { isRemoteRequest } from "./access.ts";
import {
	companionFocus,
	companionStatus,
	disableCompanion,
	enableCompanion,
	noteCompanionSeen,
	repairCompanion,
	setCompanionFocus,
} from "./service.ts";
import { TailscaleError } from "./tailscale.ts";
import { transcribeNotebook, TranscribeError } from "./transcribe.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

function error(message: string, status: number): Response {
	return json({ error: message }, status);
}

function remote(req: Request): boolean {
	return isRemoteRequest(req.headers, new URL(req.url).host);
}

/** The chat a companion request may touch: remote callers only the focused
 *  session (the iPad follows the desktop); local callers any named chat. */
function targetChat(req: Request, requested: unknown): { chatId: string } | Response {
	const focus = companionFocus();
	if (remote(req)) {
		noteCompanionSeen();
		if (!focus) return error("Open a session on the desktop first.", 409);
		if (requested !== undefined && requested !== focus) return error("The desktop switched to another session.", 409);
		return { chatId: focus };
	}
	const chatId = typeof requested === "string" && requested ? requested : focus;
	if (!chatId) return error("Open a session on the desktop first.", 409);
	return { chatId };
}

// ─── admin (desktop only: proxy.ts keeps remote callers out) ───────────────

export async function companionAdminStatus(): Promise<Response> {
	return json(await companionStatus());
}

export async function companionAdminEnable(): Promise<Response> {
	try {
		return json(await enableCompanion());
	} catch (err) {
		if (err instanceof TailscaleError) return error(err.message, 503);
		throw err;
	}
}

export async function companionAdminDisable(): Promise<Response> {
	return json(await disableCompanion());
}

export async function companionAdminRepair(): Promise<Response> {
	return json(await repairCompanion());
}

export async function companionAdminFocus(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as { chatId?: unknown; seq?: unknown } | null;
	const chatId = typeof body?.chatId === "string" && /^[A-Za-z0-9_-]+$/.test(body.chatId) ? body.chatId : null;
	const seq = typeof body?.seq === "number" && Number.isFinite(body.seq) ? body.seq : Date.now();
	setCompanionFocus(chatId, seq);
	return json({ ok: true });
}

// ─── the iPad's surface ────────────────────────────────────────────────────

export type CompanionPrompt =
	| {
			type: "question";
			toolCallId: string;
			tool: string;
			question: string;
			details?: string;
			/** Free-form questions can be answered from the notebook; the rest stay on the desktop. */
			freeForm: boolean;
	  }
	| { type: "problem"; problemCallId: string; statement: string };

export interface CompanionState {
	chatId: string | null;
	title: string | null;
	kind: "teach" | "practice" | null;
	busy: boolean;
	prompt: CompanionPrompt | null;
	pages: Array<Pick<NotebookPage, "id" | "kind" | "version" | "sentVersion" | "hasContent" | "ext">>;
}

function promptOf(messages: Parameters<typeof danglingQuestionOf>[0]): CompanionPrompt | null {
	const question = danglingQuestionOf(messages);
	if (question) {
		const input = (question.input ?? {}) as { question?: unknown; details?: unknown; options?: unknown };
		const kind = toolQuestionKind(question.tool);
		const options = parseOptionsIfString(input.options as string | unknown[] | undefined);
		const freeForm = kind === "explain" || (kind === "ask" && !(Array.isArray(options) && options.length > 0));
		return {
			type: "question",
			toolCallId: question.toolCallId,
			tool: question.tool,
			question: typeof input.question === "string" ? input.question : "",
			...(typeof input.details === "string" && input.details ? { details: input.details } : {}),
			freeForm,
		};
	}
	const problem = activeProblemOf(messages);
	if (problem) {
		const statement = (problem.input as { statement?: unknown } | null)?.statement;
		return { type: "problem", problemCallId: problem.toolCallId, statement: typeof statement === "string" ? statement : "" };
	}
	return null;
}

export function companionStateFor(chatId: string | null): CompanionState {
	const record = chatId ? stores.chatStore.getChat(chatId) : null;
	if (!chatId || !record) return { chatId: null, title: null, kind: null, busy: false, prompt: null, pages: [] };
	const notebook = stores.notebookStore.read(chatId);
	return {
		chatId,
		title: record.title,
		kind: record.kind === "practice" ? "practice" : "teach",
		busy: isTurnRunning(chatId),
		prompt: promptOf(record.messages),
		pages: (notebook?.pages ?? []).map(({ id, kind, version, sentVersion, hasContent, ext }) => ({ id, kind, version, sentVersion, hasContent, ext })),
	};
}

export async function companionState(req: Request): Promise<Response> {
	const requested = new URL(req.url).searchParams.get("chatId");
	const target = targetChat(req, requested ?? undefined);
	if (target instanceof Response) {
		// No focused session is a normal state for the iPad, not an error.
		return target.status === 409 && !companionFocus() ? json(companionStateFor(null)) : target;
	}
	return json(companionStateFor(target.chatId));
}

function imageExt(bytes: Buffer): "png" | "jpg" | null {
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	return null;
}

/** PUT: save a page (ink snapshot + strokes, or a photo). */
export async function companionSavePage(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as {
		chatId?: unknown; pageId?: unknown; kind?: unknown; hasContent?: unknown; image?: unknown; strokes?: unknown;
	} | null;
	if (!body) return error("Invalid JSON body.", 400);
	const target = targetChat(req, body.chatId);
	if (target instanceof Response) return target;
	if (!stores.chatStore.getChat(target.chatId)) return error("Unknown chat", 404);
	if (!isNotebookPageId(body.pageId)) return error("Invalid page id.", 400);
	if (body.kind !== "ink" && body.kind !== "photo") return error("Invalid page kind.", 400);
	if (typeof body.image !== "string") return error("The page image is missing.", 400);
	const image = Buffer.from(body.image.replace(/^data:image\/[a-z]+;base64,/, ""), "base64");
	const ext = imageExt(image);
	if (!ext) return error("The page image must be PNG or JPEG.", 400);
	if (body.strokes !== undefined && typeof body.strokes !== "string") return error("Invalid strokes.", 400);
	try {
		const page = stores.notebookStore.savePage(target.chatId, {
			pageId: body.pageId,
			kind: body.kind,
			hasContent: body.hasContent !== false,
			image,
			ext,
			...(typeof body.strokes === "string" ? { strokes: body.strokes } : {}),
		});
		return json({ page });
	} catch (err) {
		if (err instanceof NotebookStoreError) return error(err.message, 400);
		throw err;
	}
}

/** GET ?pageId: an ink page's strokes (the iPad reloads its notebook). */
export async function companionReadPage(req: Request): Promise<Response> {
	const params = new URL(req.url).searchParams;
	const target = targetChat(req, params.get("chatId") ?? undefined);
	if (target instanceof Response) return target;
	const pageId = params.get("pageId");
	if (!isNotebookPageId(pageId)) return error("Invalid page id.", 400);
	const strokes = stores.notebookStore.readStrokes(target.chatId, pageId);
	return json({ strokes });
}

export async function companionDeletePage(req: Request): Promise<Response> {
	const params = new URL(req.url).searchParams;
	const target = targetChat(req, params.get("chatId") ?? undefined);
	if (target instanceof Response) return target;
	const pageId = params.get("pageId");
	if (!isNotebookPageId(pageId)) return error("Invalid page id.", 400);
	return json({ deleted: stores.notebookStore.deletePage(target.chatId, pageId) });
}

/** GET ?chatId&file: one snapshot (desktop answered cards, iPad photo pages). */
export async function companionFile(req: Request): Promise<Response> {
	const params = new URL(req.url).searchParams;
	const target = targetChat(req, params.get("chatId") ?? undefined);
	if (target instanceof Response) return target;
	const file = params.get("file");
	if (!isNotebookFileName(file)) return error("Invalid file.", 400);
	const bytes = stores.notebookStore.readImage(target.chatId, file);
	if (!bytes) return error("Not found.", 404);
	return new Response(new Uint8Array(bytes), {
		headers: {
			"Content-Type": file.endsWith(".png") ? "image/png" : "image/jpeg",
			// Versioned file names never change content.
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
}

function attachmentsFor(chatId: string, pageIds: unknown): NotebookAttachment[] {
	const notebook = stores.notebookStore.read(chatId);
	if (!notebook) return [];
	const wanted = Array.isArray(pageIds) ? new Set(pageIds.filter(isNotebookPageId)) : null;
	// Transcription reads the CURRENT version of the chosen pages, sent or not.
	return changedPageAttachments({
		chatId,
		pages: notebook.pages
			.filter((p) => p.hasContent && p.version > 0 && (!wanted || wanted.has(p.id)))
			.map((p) => ({ ...p, sentVersion: 0 })),
	}).map((a) => ({ ...a, pageNumber: notebook.pages.findIndex((p) => p.id === a.pageId) + 1 }));
}

/** POST {chatId, pageIds?}: the vision slot's transcription of the pages. */
export async function companionTranscribe(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as { chatId?: unknown; pageIds?: unknown } | null;
	if (!body) return error("Invalid JSON body.", 400);
	const target = targetChat(req, body.chatId);
	if (target instanceof Response) return target;
	try {
		const text = await transcribeNotebook(target.chatId, attachmentsFor(target.chatId, body.pageIds));
		return json({ text });
	} catch (err) {
		if (err instanceof TranscribeError) return error(err.message, err.status);
		console.error(`[companion ${target.chatId}] transcription failed:`, err);
		return error(err instanceof Error ? `Transcription failed: ${err.message}` : "Transcription failed.", 502);
	}
}

/** POST {chatId, target, text}: answer the pending free-form question (or
 *  submit thinking on the active practice problem) from the notebook. The
 *  turn runs server-side; the desktop attaches to it live. */
export async function companionAnswer(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as { chatId?: unknown; target?: unknown; text?: unknown } | null;
	if (!body) return error("Invalid JSON body.", 400);
	const target = targetChat(req, body.chatId);
	if (target instanceof Response) return target;
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return error("Write or transcribe an answer first.", 400);
	if (typeof body.target !== "string" || !body.target) return error("Missing question.", 400);
	const record = stores.chatStore.getChat(target.chatId);
	if (!record) return error("Unknown chat", 404);
	if (isTurnRunning(target.chatId)) return error("The teacher is still responding. Try again in a moment.", 409);

	const prompt = promptOf(record.messages);
	let res: Response;
	if (prompt?.type === "question" && prompt.toolCallId === body.target) {
		if (!prompt.freeForm) return error("This question is answered on the desktop.", 409);
		const pending = danglingQuestionOf(record.messages)!;
		const qd = questionDataFromCall(toolQuestionKind(pending.tool), pending.toolCallId, pending.input as QuizToolInput);
		const answer = { ...buildAnswer(qd, { text }, pending.tool), via: "ipad" as const };
		res = await handleChatInput(target.chatId, { type: "answer", toolCallId: pending.toolCallId, answer }, undefined, "ipad");
	} else if (prompt?.type === "problem" && prompt.problemCallId === body.target) {
		res = await handleChatInput(target.chatId, { type: "thinking", problemCallId: prompt.problemCallId, text }, undefined, "ipad");
	} else {
		return error("That question was already answered.", 409);
	}
	if (!res.ok) {
		const detail = await res.json().catch(() => null) as { error?: string; message?: string } | null;
		return error(detail?.error ?? detail?.message ?? "The answer could not be sent.", res.status);
	}
	// The turn is server-owned: detaching this view never aborts it.
	await res.body?.cancel().catch(() => {});
	return json({ ok: true });
}
