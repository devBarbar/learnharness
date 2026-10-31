/**
 * The iPad companion notebook: the attachment contract, the model-facing
 * image window, the store's versioning, the access gate, and the full
 * answer path (a changed page rides the next answer exactly once, and the
 * model's continuation sees it as an image).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import {
	changedPageAttachments,
	isNotebookFileName,
	validNotebookAttachments,
	type NotebookAttachment,
	type NotebookRecord,
} from "../src/core/contracts/notebook.ts";
import { parseChatInput, inputAppends } from "../src/core/input-events.ts";
import { newAnswerResult, newThinkingMessage, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { buildAnswer, questionDataFromCall, type QuestionAnswerData } from "../src/core/question-core.ts";
import { companionAuthorized, hashCompanionToken, isRemoteRequest, remotePathAllowed } from "../src/server/companion/access.ts";
import { parseTailscaleStatus } from "../src/server/companion/tailscale.ts";
import { companionAnswer, companionStateFor } from "../src/server/companion/api.ts";
import { setCompanionFocus } from "../src/server/companion/service.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { jobStore } from "../src/store/jobs.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { notebookStore } from "../src/store/notebooks.ts";
import { eraseAt, parseStrokes, serializeStrokes, snapshotHeight, PAGE_HEIGHT, type Stroke } from "../components/companion/ink.ts";
import type { PiEngine } from "../src/agent/models.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

// A real 1×1 PNG (the store validates nothing but size; the API checks magic bytes).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try { fs.unlinkSync(path.join(PATHS.chats, `${id}.json`)); } catch { /* gone */ }
		fs.rmSync(path.join(PATHS.data, "notebooks", id), { recursive: true, force: true });
	}
});

function attachment(pageId: string, version: number, pageNumber = 1): NotebookAttachment {
	return { pageId, pageNumber, kind: "ink", version, file: `${pageId}-v${version}.png`, mimeType: "image/png" };
}

describe("notebook contract", () => {
	it("attaches only pages changed since their last send, never blank ones", () => {
		const record: NotebookRecord = {
			chatId: "c",
			pages: [
				{ id: "pg_aaaaaaaa", kind: "ink", version: 3, sentVersion: 3, hasContent: true, ext: "png", updatedAt: "" },
				{ id: "pg_bbbbbbbb", kind: "ink", version: 2, sentVersion: 1, hasContent: true, ext: "png", updatedAt: "" },
				{ id: "pg_cccccccc", kind: "ink", version: 4, sentVersion: 0, hasContent: false, ext: "png", updatedAt: "" },
				{ id: "pg_dddddddd", kind: "photo", version: 1, sentVersion: 0, hasContent: true, ext: "jpg", updatedAt: "" },
			],
		};
		assert.deepEqual(changedPageAttachments(record), [
			{ pageId: "pg_bbbbbbbb", pageNumber: 2, kind: "ink", version: 2, file: "pg_bbbbbbbb-v2.png", mimeType: "image/png" },
			{ pageId: "pg_dddddddd", pageNumber: 4, kind: "photo", version: 1, file: "pg_dddddddd-v1.jpg", mimeType: "image/jpeg" },
		]);
		assert.deepEqual(changedPageAttachments(null), []);
	});

	it("file names admit no traversal; foreign attachments degrade to omission", () => {
		for (const bad of ["../x.png", "pg_aaaaaaaa-v1.png/..", "pg_aaaaaaaa-v0.png", "pg_aaaaaaaa-v1.gif", "notebook.json", "pg_a-v1.png"]) {
			assert.equal(isNotebookFileName(bad), false, bad);
		}
		assert.equal(isNotebookFileName("pg_aaaaaaaa-v12.jpg"), true);
		assert.deepEqual(validNotebookAttachments([{ ...attachment("pg_aaaaaaaa", 1), file: "../../auth.json" }, "junk", null]), []);
	});

	it("clients cannot smuggle notebook references into an answer", () => {
		const parsed = parseChatInput({
			type: "answer",
			toolCallId: "call-1",
			answer: { kind: "explain", questionText: "q", dontKnow: false, answers: [], answeredAt: "", notebook: [attachment("pg_aaaaaaaa", 1)], notebookNoVision: true, via: "ipad" },
		});
		assert.equal(parsed.type, "answer");
		const answer = (parsed as { answer: QuestionAnswerData }).answer;
		assert.equal(answer.notebook, undefined);
		assert.equal(answer.notebookNoVision, undefined);
		assert.equal(answer.via, undefined);
	});
});

describe("the model-facing image window", () => {
	const wire = {
		vision: true,
		image: (a: NotebookAttachment) => ({ data: Buffer.from(a.file).toString("base64"), mimeType: a.mimeType }),
	};
	const answerWith = (id: string, attachments: NotebookAttachment[]): LhMessage =>
		newAnswerResult(id, "explain", { kind: "explain", questionText: "q", dontKnow: false, answers: [], answeredAt: "", text: "a", notebook: attachments });

	it("answers carry their pages as labelled images; only the newest three keep images", () => {
		const msgs = [1, 2, 3, 4].map((n) => answerWith(`call-${n}`, [attachment(`pg_page000${n}`, 1, n)]));
		const out = toLlmMessages(msgs, wire);
		const images = out.map((m) => (m.content as Array<{ type: string }>).filter((b) => b.type === "image").length);
		assert.deepEqual(images, [0, 1, 1, 1]);
		const oldest = JSON.stringify(out[0]!.content);
		assert.match(oldest, /omitted here to save context/);
		const newest = out[3]!.content as Array<{ type: string; text?: string; data?: string }>;
		assert.match(newest.find((b) => b.type === "text" && /iPad notebook — page 4/.test(b.text ?? ""))!.text!, /changed since their last answer/);
		assert.equal(newest.find((b) => b.type === "image")!.data, Buffer.from("pg_page0004-v1.png").toString("base64"));
	});

	it("without a resolver or vision, the model gets an honest note instead of images", () => {
		const msg = answerWith("call-1", [attachment("pg_aaaaaaaa", 2)]);
		assert.match(JSON.stringify(toLlmMessages([msg])[0]!.content), /omitted here to save context/);
		assert.match(JSON.stringify(toLlmMessages([msg], { ...wire, vision: false })[0]!.content), /cannot read images/);
		const missing = toLlmMessages([msg], { vision: true, image: () => null })[0]!;
		assert.match(JSON.stringify(missing.content), /no longer available/);
	});

	it("practice thinking carries its pages on the flattened user message", () => {
		const marker = newThinkingMessage("call_p1", "my working", { attachments: [attachment("pg_aaaaaaaa", 1)], noVision: false, via: "ipad" });
		assert.deepEqual((marker.details as { via?: string }).via, "ipad");
		const [out] = toLlmMessages([marker], wire);
		const blocks = out!.content as Array<{ type: string; text?: string }>;
		assert.equal(out!.role, "user");
		assert.match(blocks[0]!.text!, /my working/);
		assert.equal(blocks.filter((b) => b.type === "image").length, 1);
	});

	it("an answer without changed pages is byte-identical to before", () => {
		const plain = newAnswerResult("call-1", "explain", { kind: "explain", questionText: "q", dontKnow: false, answers: [], answeredAt: "", text: "a" });
		const [out] = toLlmMessages([plain], wire);
		assert.deepEqual(out!.content, plain.content);
	});
});

describe("notebook store", () => {
	it("versions pages, prunes unsent superseded snapshots, keeps sent ones", () => {
		const chat = chatStore.createChat("Test: notebook store");
		createdChats.push(chat.id);
		const dir = path.join(PATHS.data, "notebooks", chat.id);
		notebookStore.savePage(chat.id, { pageId: "pg_storepage", kind: "ink", hasContent: true, image: PNG, ext: "png", strokes: "{}" });
		notebookStore.savePage(chat.id, { pageId: "pg_storepage", kind: "ink", hasContent: true, image: PNG, ext: "png", strokes: "{}" });
		assert.ok(!fs.existsSync(path.join(dir, "pg_storepage-v1.png")), "unsent v1 pruned");
		const [sent] = changedPageAttachments(notebookStore.read(chat.id));
		assert.equal(sent!.version, 2);
		notebookStore.markSent(chat.id, [sent!]);
		assert.deepEqual(changedPageAttachments(notebookStore.read(chat.id)), []);
		notebookStore.savePage(chat.id, { pageId: "pg_storepage", kind: "ink", hasContent: true, image: PNG, ext: "png" });
		assert.ok(fs.existsSync(path.join(dir, "pg_storepage-v2.png")), "a sent snapshot survives later edits");
		assert.equal(changedPageAttachments(notebookStore.read(chat.id))[0]!.version, 3);
		assert.throws(() => notebookStore.readImage(chat.id, "../notebook.json"));
		assert.equal(notebookStore.deletePage(chat.id, "pg_storepage"), true);
		assert.ok(fs.existsSync(path.join(dir, "pg_storepage-v2.png")), "deleting a page keeps what answers referenced");
	});
});

describe("companion access gate", () => {
	const token = "t".repeat(43);
	const config = { enabled: true, tokenHash: hashCompanionToken(token), ownerLogin: "Owner@github" };
	const h = (init: Record<string, string>) => new Headers(init);

	it("Next's own loopback x-forwarded stamps stay local; tailnet traffic is remote", () => {
		assert.equal(isRemoteRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:3100" })), false);
		assert.equal(isRemoteRequest(h({ host: "localhost:3000" })), false);
		assert.equal(isRemoteRequest(new Headers(), "localhost:3000"), false);
		assert.equal(isRemoteRequest(h({ host: "desktop.tail1.ts.net:8443" })), true);
		assert.equal(isRemoteRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "100.107.140.48, 127.0.0.1" })), true);
		assert.equal(isRemoteRequest(h({ host: "127.0.0.1:3100", "tailscale-user-login": "owner@github" })), true);
		assert.equal(isRemoteRequest(h({ host: "192.168.1.20:3000" })), true);
	});

	it("remote callers reach only the companion surface", () => {
		for (const p of ["/companion", "/_next/static/x.js", "/api/companion/state", "/api/companion/page"]) assert.ok(remotePathAllowed(p), p);
		for (const p of ["/", "/chat/abc", "/settings", "/api/settings", "/api/chat", "/api/companion/admin/disable", "/api/events"]) assert.ok(!remotePathAllowed(p), p);
	});

	it("needs the switch, the token, and (remotely) the owner's Tailscale login", () => {
		const ok = { "x-learnharness-companion": token, "tailscale-user-login": "owner@GitHub" };
		assert.equal(companionAuthorized(h(ok), config, true), true);
		assert.equal(companionAuthorized(h({ ...ok, "tailscale-user-login": "someone-else@github" }), config, true), false);
		assert.equal(companionAuthorized(h({ "x-learnharness-companion": token }), config, true), false);
		assert.equal(companionAuthorized(h({ "x-learnharness-companion": token }), config, false), true);
		assert.equal(companionAuthorized(h({ ...ok, "x-learnharness-companion": "u".repeat(43) }), config, true), false);
		assert.equal(companionAuthorized(h(ok), { ...config, enabled: false }, true), false);
	});

	it("reads Tailscale's identity from status --json", () => {
		const id = parseTailscaleStatus(JSON.stringify({
			BackendState: "Running",
			Self: { DNSName: "desktop-1.tail945cf5.ts.net.", UserID: 7 },
			User: { "7": { LoginName: "owner@github" } },
		}));
		assert.deepEqual(id, { dnsName: "desktop-1.tail945cf5.ts.net", ownerLogin: "owner@github" });
		assert.throws(() => parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" })), /not connected/);
	});
});

describe("ink model", () => {
	const stroke = (y: number): Stroke => ({ tool: "pen", color: "#000", width: 5, points: [[10, y, 0.5], [200, y, 0.6]] });

	it("round-trips strokes and erases whole strokes the eraser touches", () => {
		const strokes = [stroke(100), stroke(400)];
		assert.deepEqual(parseStrokes(serializeStrokes(strokes)), strokes);
		assert.deepEqual(parseStrokes("not json"), []);
		const kept = eraseAt(strokes, 100, 102, 10);
		assert.deepEqual(kept, [strokes[1]]);
		assert.equal(eraseAt(strokes, 900, 900, 10), strokes, "untouched → same array (no spurious save)");
	});

	it("crops snapshots to the inked part of the page", () => {
		assert.equal(snapshotHeight([]), Math.round(PAGE_HEIGHT / 3));
		assert.equal(snapshotHeight([stroke(1500)]), 1590);
		assert.equal(snapshotHeight([stroke(5000)]), PAGE_HEIGHT);
	});
});

// ─── the answer path, end to end (scripted model) ──────────────────────────

const EXPLAIN_INPUT = {
	question: "Explain why Mercury is hard to observe.",
	correctAnswer: "It never strays far from the Sun in our sky.",
	nodeId: "planet-order",
	type: "check",
};

function scripted(steps: (seen: unknown[][]) => FauxResponseStep[]): { engine: PiEngine; seen: unknown[][] } {
	const seen: unknown[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(seen));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, seen };
}

async function turn(chatId: string, input: unknown, engine: PiEngine): Promise<void> {
	// Free recall armed (the explain mechanic), exactly as chat-flow does.
	const tools = createTeacherTools({ chatId, chatStore, jobStore, spawn: () => {} }, { explain: true });
	const ack = await handleChatRequest(
		new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ chatId, input }) }),
		(opts) => createTeacherAgent(undefined, { engine, messages: opts.messages, tools, notebookImage: opts.notebookImage }),
	);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

describe("answers carry the changed notebook pages", () => {
	it("a changed page rides the next answer once, as an image the model sees", async () => {
		const { engine, seen } = scripted((s) => [
			(ctx) => { s.push(ctx.messages.map((m) => m.content)); return fauxAssistantMessage([fauxToolCall("explain", EXPLAIN_INPUT, { id: "call-1" })], { stopReason: "toolUse" }); },
			(ctx) => { s.push(ctx.messages.map((m) => m.content)); return fauxAssistantMessage([fauxToolCall("explain", { ...EXPLAIN_INPUT, question: "And Venus?" }, { id: "call-2" })], { stopReason: "toolUse" }); },
			(ctx) => { s.push(ctx.messages.map((m) => m.content)); return fauxAssistantMessage([fauxText("Good.")]); },
		]);
		const chat = chatStore.createChat("Test: notebook answers");
		createdChats.push(chat.id);
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });

		await turn(chat.id, { type: "text", text: "teach me" }, engine);
		notebookStore.savePage(chat.id, { pageId: "pg_mindmap01", kind: "ink", hasContent: true, image: PNG, ext: "png", strokes: "{}" });

		// The iPad's view of the pending question: free-form → answerable there.
		const state = companionStateFor(chat.id);
		assert.deepEqual(state.prompt && { type: state.prompt.type, freeForm: (state.prompt as { freeForm: boolean }).freeForm }, { type: "question", freeForm: true });
		assert.equal(state.pages[0]!.version, 1);

		// Answer from the desktop: the page attaches and is marked sent.
		const qd = questionDataFromCall("explain", "call-1", EXPLAIN_INPUT as never);
		await turn(chat.id, { type: "answer", toolCallId: "call-1", answer: buildAnswer(qd, { text: "It hugs the Sun." }, "explain") }, engine);
		const saved = chatStore.getChat(chat.id)!;
		const result = saved.messages.find((m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-1")!;
		const details = (result as { details: QuestionAnswerData }).details;
		assert.deepEqual(details.notebook?.map((a) => a.file), ["pg_mindmap01-v1.png"]);
		assert.equal(details.notebookNoVision, undefined, "the pinned model reads images");
		assert.deepEqual(changedPageAttachments(notebookStore.read(chat.id)), [], "marked sent");

		// The model's continuation saw the page as an image block.
		const second = JSON.stringify(seen[1]);
		assert.match(second, /"type":"image"/);
		assert.match(second, /iPad notebook — page 1/);

		// Nothing changed since → the next answer carries no pages.
		const qd2 = questionDataFromCall("explain", "call-2", { ...EXPLAIN_INPUT, question: "And Venus?" } as never);
		await turn(chat.id, { type: "answer", toolCallId: "call-2", answer: buildAnswer(qd2, { text: "Also inner." }, "explain") }, engine);
		const result2 = chatStore.getChat(chat.id)!.messages.find((m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-2")!;
		assert.equal((result2 as { details: QuestionAnswerData }).details.notebook, undefined);
	});

	it("inputAppends stamps nothing when no page changed", () => {
		const record = { messages: [] as LhMessage[] };
		assert.throws(() => inputAppends(record, { type: "answer", toolCallId: "x", answer: {} as QuestionAnswerData }, { attachments: [], noVision: false }));
	});

	it("the iPad answer route refuses what belongs on the desktop", async () => {
		const chat = chatStore.createChat("Test: companion answer refusals");
		createdChats.push(chat.id);
		setCompanionFocus(chat.id, Date.now());
		const post = (body: unknown) => companionAnswer(new Request("http://localhost/api/companion/answer", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify(body) }));
		assert.equal((await post({ chatId: chat.id, target: "call-1", text: "" })).status, 400);
		const stale = await post({ chatId: chat.id, target: "call-1", text: "hi" });
		assert.equal(stale.status, 409);
		assert.match((await stale.json() as { error: string }).error, /already answered/);
		setCompanionFocus(null, Date.now() + 1);
	});
});
