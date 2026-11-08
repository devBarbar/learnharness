/**
 * The read-aloud player's queue semantics (speech wave, 2026-11-08): new
 * texts queue behind the one being read, Stop drops the queue, "listen
 * again" interrupts and replays, and a finished text joins the stored set.
 * fetch and Audio are scripted — the player's seams.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSpeechPlayer, type SpeechItem } from "../components/speech-player.ts";

const played: string[] = [];
let holdPlayback = false;
const releasers: Array<() => void> = [];

class FakeAudio extends EventTarget {
	src = "";
	playbackRate = 1;
	play(): Promise<void> {
		played.push(`${this.src}@${this.playbackRate}`);
		const end = () => this.dispatchEvent(new Event("ended"));
		if (holdPlayback) releasers.push(end);
		else setTimeout(end, 1);
		return Promise.resolve();
	}
	pause() {}
}
(globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;

const requested: string[] = [];
const fakeFetch = (async (_url: string, init?: RequestInit) => {
	const { text } = JSON.parse(String(init?.body)) as { text: string };
	requested.push(text);
	const lines = [
		{ type: "chunk", index: 0, url: `/a/${text}/0.mp3` },
		{ type: "chunk", index: 1, url: `/a/${text}/1.mp3` },
		{ type: "done", cached: false },
	].map((e) => JSON.stringify(e)).join("\n") + "\n";
	return new Response(lines, { headers: { "Content-Type": "application/x-ndjson" } });
}) as typeof fetch;

const item = (key: string): SpeechItem => ({ chatId: "chat_a", key: `s1${key.padStart(14, "0")}`, text: key });

async function idle(player: ReturnType<typeof createSpeechPlayer>) {
	for (let i = 0; i < 200 && player.getSnapshot().phase !== "idle"; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("speech player", () => {
	it("reads queued texts in order, piece by piece, at the set rate, and marks them stored", async () => {
		played.length = 0;
		requested.length = 0;
		const player = createSpeechPlayer(fakeFetch);
		player.setRate(1.25);
		player.enqueue(item("eins"));
		player.enqueue(item("zwei"));
		player.enqueue(item("zwei")); // duplicate while queued: ignored
		await idle(player);
		assert.deepEqual(requested, ["eins", "zwei"]);
		assert.deepEqual(played, ["/a/eins/0.mp3@1.25", "/a/eins/1.mp3@1.25", "/a/zwei/0.mp3@1.25", "/a/zwei/1.mp3@1.25"]);
		assert.deepEqual([...player.getSnapshot().stored.get("chat_a")!], [item("eins").key, item("zwei").key]);
	});

	it("Stop ends the current text and drops the queue", async () => {
		played.length = 0;
		requested.length = 0;
		holdPlayback = true;
		const player = createSpeechPlayer(fakeFetch);
		player.enqueue(item("eins"));
		player.enqueue(item("zwei"));
		for (let i = 0; i < 100 && played.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		assert.equal(player.getSnapshot().queued, 1);
		player.stop();
		holdPlayback = false;
		releasers.splice(0).forEach((r) => r());
		await idle(player);
		assert.deepEqual(requested, ["eins"]);
		assert.deepEqual(played, ["/a/eins/0.mp3@1"]);
		assert.equal(player.getSnapshot().error, null);
		assert.equal(player.getSnapshot().stored.get("chat_a"), undefined);
	});

	it("listen again interrupts and replays the chosen text", async () => {
		played.length = 0;
		requested.length = 0;
		holdPlayback = true;
		const player = createSpeechPlayer(fakeFetch);
		player.enqueue(item("eins"));
		player.enqueue(item("zwei"));
		for (let i = 0; i < 100 && played.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		holdPlayback = false;
		player.replay(item("drei"));
		releasers.splice(0).forEach((r) => r());
		await idle(player);
		assert.deepEqual(requested, ["eins", "drei"]);
		assert.equal(played.at(-1), "/a/drei/1.mp3@1");
	});

	it("surfaces a server failure for the chat it belongs to", async () => {
		const player = createSpeechPlayer((async () => Response.json({ message: "No OpenAI key" }, { status: 503 })) as typeof fetch);
		player.enqueue(item("eins"));
		await idle(player);
		assert.deepEqual(player.getSnapshot().error, { chatId: "chat_a", message: "No OpenAI key" });
		player.dismissError();
		assert.equal(player.getSnapshot().error, null);
	});
});
