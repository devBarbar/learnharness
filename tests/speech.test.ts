/**
 * Read-aloud (speech wave, 2026-11-08): the cache key, the streaming
 * chunker, the settings seams, the formula reference (KaTeX → SRE), the
 * script prompt input, which tutor texts count as complete, and the full
 * POST /api/speech path with scripted model + synthesis (stream events,
 * stored pieces, the free "listen again" replay, failure cleanup).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import {
	DEFAULT_SPEECH_INSTRUCTIONS,
	FACTORY_SETTINGS,
	SpeechChunker,
	isSpeechKey,
	resolveSettings,
	sanitizeUserSettings,
	speechKey,
	type LhViewMessage,
	type SpeechStreamEvent,
} from "../src/core/index.ts";
import { parseSpeechSettingsBody } from "../src/server/settings-body.ts";
import { extractFormulas, formulaReferences, sreLocale } from "../src/server/speech/math.ts";
import { SPEECH_SCRIPT_SYSTEM_PROMPT, speechScriptInput } from "../src/server/speech/script.ts";
import { speechList, speechPiece, speechSpeak } from "../src/server/speech/api.ts";
import { speechStore } from "../src/store/speech.ts";
import { chatStore } from "../src/store/chats.ts";
import { tutorTexts } from "../components/chat-speech.tsx";

process.env.OPENAI_API_KEY ??= "test-key-presence-gate";

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try { fs.unlinkSync(path.join(PATHS.chats, `${id}.json`)); } catch { /* gone */ }
		fs.rmSync(path.join(PATHS.data, "speech", id), { recursive: true, force: true });
	}
});

describe("speechKey", () => {
	it("is stable, content-keyed and validated by isSpeechKey", () => {
		const a = speechKey("Deine $6$ stimmt.");
		assert.equal(a, speechKey("Deine $6$ stimmt."));
		assert.notEqual(a, speechKey("Deine $7$ stimmt."));
		assert.ok(isSpeechKey(a));
		assert.equal(isSpeechKey("../etc"), false);
		assert.equal(isSpeechKey("s1"), false);
	});
});

describe("SpeechChunker", () => {
	it("starts with a short first piece, then cuts at paragraphs and sentence ends", () => {
		const c = new SpeechChunker();
		const text = "Deine Sechs stimmt, und auch dein Grund ist richtig. Wenn Anna ein Amt hat, kommen nur noch Ben und Cem infrage.\n\nDer Gedanke dahinter ist einfach. " + "Wir sortieren die Besetzungen nach Komitee. ".repeat(8);
		const pieces: string[] = [];
		for (const ch of text) pieces.push(...c.push(ch));
		pieces.push(...c.flush());
		assert.equal(pieces[0], "Deine Sechs stimmt, und auch dein Grund ist richtig.");
		assert.equal(pieces.join(" ").replace(/\s+/g, " "), text.trim().replace(/\s+/g, " "));
		for (const p of pieces) assert.ok(p.length <= 900);
	});

	it("cuts a run-on without sentence ends at a space", () => {
		const c = new SpeechChunker();
		const pieces = [...c.push("wort ".repeat(400)), ...c.flush()];
		assert.ok(pieces.length >= 2);
		assert.ok(pieces.every((p) => !p.startsWith(" ") && p.length <= 900));
	});
});

describe("speech settings", () => {
	it("resolves the factory (off, marin, 1×, the tutor instruction)", () => {
		assert.deepEqual(resolveSettings(null).speech, FACTORY_SETTINGS.speech);
		assert.equal(FACTORY_SETTINGS.speech.autoRead, false);
		assert.equal(FACTORY_SETTINGS.speech.voice, "marin");
		assert.equal(FACTORY_SETTINGS.speech.instructions, DEFAULT_SPEECH_INSTRUCTIONS);
	});

	it("sanitizes on read: bad voice drops, tempo clamps, other keys survive", () => {
		const record = sanitizeUserSettings({ version: 1, speech: { autoRead: true, voice: "robot", speed: 9, instructions: 4 } });
		assert.deepEqual(record?.speech, { autoRead: true, speed: 2 });
	});

	it("rejects bad writes strictly", () => {
		assert.ok(parseSpeechSettingsBody({ autoRead: true, voice: "coral", speed: 1.25, instructions: "ruhig" }).ok);
		assert.equal(parseSpeechSettingsBody({ voice: "robot" }).ok, false);
		assert.equal(parseSpeechSettingsBody({ speed: 3 }).ok, false);
		assert.equal(parseSpeechSettingsBody({ autoRead: "yes" }).ok, false);
		assert.equal(parseSpeechSettingsBody({ instructions: "x".repeat(2001) }).ok, false);
	});
});

describe("formula reference", () => {
	it("extracts inline and display math in order, skipping code and duplicates", () => {
		const md = "Deine $6$ stimmt. `$x$` ist Code.\n\n$$\n\\binom{n}{k} = \\frac{n!}{k!\\,(n-k)!}\n$$\n\nNochmal $6$ und \\(k!\\).";
		assert.deepEqual(extractFormulas(md), [
			{ tex: "6", display: false },
			{ tex: "\\binom{n}{k} = \\frac{n!}{k!\\,(n-k)!}", display: true },
			{ tex: "k!", display: false },
		]);
	});

	it("maps dictation languages onto SRE locales", () => {
		assert.equal(sreLocale("de"), "de");
		assert.equal(sreLocale("de-CH"), "de");
		assert.equal(sreLocale("ja"), "en");
	});

	it("reads structure with MathSpeak (German)", async () => {
		const [ref] = await formulaReferences("$\\frac{n!}{k!\\,(n-k)!}$", "de");
		assert.match(ref!.reading, /Anfang Bruch n Fakultät durch k Fakultät Klammer auf n minus k Klammer zu Fakultät Ende Bruch/);
	});

	it("feeds the script model the message plus one reference line per formula", () => {
		const input = speechScriptInput("Also $0! = 1$.", [{ tex: "0! = 1", display: false, reading: "0 Fakultät ist gleich 1" }]);
		assert.match(input, /Tutor-Nachricht:\n"""\nAlso \$0! = 1\$\.\n"""/);
		assert.match(input, /1\. \$0! = 1\$ → 0 Fakultät ist gleich 1/);
		assert.match(SPEECH_SCRIPT_SYSTEM_PROMPT, /übernimm nie ihren Wortlaut/);
	});
});

describe("tutorTexts (auto-read completeness)", () => {
	const view = (parts: Array<{ type: string; text?: string }>): LhViewMessage[] => [
		{ id: "u", role: "user", parts: [{ type: "text", text: "Hallo" }] },
		{ id: "a", role: "assistant", parts },
	];

	it("holds back the streaming tail and releases it once something follows or the turn ends", () => {
		const parts = [{ type: "text", text: "Erstens." }, { type: "text", text: "Zweit" }];
		assert.deepEqual(tutorTexts(view(parts), true), [{ text: "Erstens.", final: true }, { text: "Zweit", final: false }]);
		assert.deepEqual(tutorTexts(view([...parts, { type: "step-start" }]), true).map((t) => t.final), [true, true]);
		assert.deepEqual(tutorTexts(view(parts), false).map((t) => t.final), [true, true]);
	});

	it("never reads learner text, reasoning or cards", () => {
		const texts = tutorTexts(view([{ type: "reasoning", text: "denke" }, { type: "tool-quiz" }, { type: "text", text: "Antwort." }]), false);
		assert.deepEqual(texts, [{ text: "Antwort.", final: true }]);
	});
});

async function events(res: Response): Promise<SpeechStreamEvent[]> {
	return (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as SpeechStreamEvent);
}

function post(chatId: string, text: string): Request {
	return new Request("http://localhost/api/speech", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, text }),
	});
}

describe("POST /api/speech", () => {
	it("streams pieces, stores them, and replays from disk without calling the services", async () => {
		const chat = chatStore.createChat("Test: speech");
		createdChats.push(chat.id);
		const text = "Man legt $0! = 1$ fest.";
		const scripted: string[] = [];
		const synthesized: string[] = [];
		const deps = {
			streamScript: async function* (t: string, refs: readonly { reading: string }[]) {
				scripted.push(t);
				assert.equal(refs[0]?.reading, "0 Fakultät ist gleich 1");
				yield "Man legt außerdem fest: Null Fakultät ist gleich eins. ";
				yield "Für nichts gibt es genau eine Anordnung.";
			},
			synthesize: async (input: string) => {
				synthesized.push(input);
				return Buffer.from(`mp3:${input}`);
			},
		};
		const first = await events(await speechSpeak(post(chat.id, text), deps));
		assert.deepEqual(first.map((e) => e.type), ["chunk", "chunk", "done"]);
		assert.deepEqual(synthesized, ["Man legt außerdem fest: Null Fakultät ist gleich eins.", "Für nichts gibt es genau eine Anordnung."]);
		const key = speechKey(text);
		assert.deepEqual(await speechList(chat.id).json(), { keys: [key] });
		const piece = speechPiece(chat.id, key, "0.mp3");
		assert.equal(piece.headers.get("Content-Type"), "audio/mpeg");
		assert.equal(Buffer.from(await piece.arrayBuffer()).toString(), "mp3:Man legt außerdem fest: Null Fakultät ist gleich eins.");

		const again = await events(await speechSpeak(post(chat.id, text), deps));
		assert.deepEqual(again.at(-1), { type: "done", cached: true });
		assert.equal(scripted.length, 1);
		assert.equal(synthesized.length, 2);
		assert.equal(speechStore.getComplete(chat.id, key, text)?.pieces.length, 2);
	});

	it("reports a synthesis failure and leaves no partial entry behind", async () => {
		const chat = chatStore.createChat("Test: speech failure");
		createdChats.push(chat.id);
		const text = "Kaputt.";
		const res = await speechSpeak(post(chat.id, text), {
			streamScript: async function* () {
				yield "Das geht schief.";
			},
			synthesize: async () => {
				throw new Error("OpenAI speech failed (401): bad key");
			},
		});
		const out = await events(res);
		assert.deepEqual(out, [{ type: "error", message: "OpenAI speech failed (401): bad key" }]);
		assert.deepEqual(await speechList(chat.id).json(), { keys: [] });
	});

	it("refuses unknown sessions, empty text and bad piece paths", async () => {
		assert.equal((await speechSpeak(post("chat_nope_00000000", "Hallo"))).status, 404);
		const chat = chatStore.createChat("Test: speech refusals");
		createdChats.push(chat.id);
		assert.equal((await speechSpeak(post(chat.id, "   "))).status, 400);
		assert.equal(speechPiece(chat.id, speechKey("x"), "../auth.json").status, 400);
		assert.equal(speechPiece(chat.id, "not-a-key", "0.mp3").status, 400);
		assert.equal(speechPiece(chat.id, speechKey("x"), "0.mp3").status, 404);
	});

	it("removes a session's audio with the session", async () => {
		const chat = chatStore.createChat("Test: speech deletion");
		createdChats.push(chat.id);
		const key = speechKey("Weg damit.");
		speechStore.begin(chat.id, key);
		speechStore.deleteChat(chat.id);
		assert.equal(fs.existsSync(path.join(PATHS.data, "speech", chat.id)), false);
	});
});
