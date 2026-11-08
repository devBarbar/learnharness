"use client";

/**
 * THE read-aloud player (speech wave, 2026-11-08): one app-lifetime queue
 * and one audio element, shared by every chat surface (the dictation
 * pattern — a module singleton behind useSyncExternalStore).
 *
 * Owner decisions: new tutor texts QUEUE behind the one being read (never
 * interrupt); Stop ends the current text and empties the queue; a text
 * already read can be listened to again from its stored audio (free).
 * Tempo is the audio element's playbackRate, so it applies to cached
 * audio too. Dictation stops reading (the mic must not hear the voice).
 */

import { useSyncExternalStore } from "react";
import type { SpeechStreamEvent } from "@/src/core";

export interface SpeechItem {
	chatId: string;
	key: string;
	text: string;
}

export interface SpeechPlayerState {
	/** The text being prepared or read, if any. */
	current: SpeechItem | null;
	phase: "idle" | "preparing" | "playing";
	/** Texts waiting behind the current one. */
	queued: number;
	/** The last failure, until dismissed or the next text starts. */
	error: { chatId: string; message: string } | null;
	/** chatId → keys with complete stored audio (the "listen again" set). */
	stored: ReadonlyMap<string, ReadonlySet<string>>;
}

const IDLE: SpeechPlayerState = { current: null, phase: "idle", queued: 0, error: null, stored: new Map() };

/** A piece-URL channel: the NDJSON reader pushes, the playback loop pulls. */
class PieceChannel {
	private urls: string[] = [];
	private ended = false;
	private wake: (() => void) | null = null;

	push(url: string) {
		this.urls.push(url);
		this.wake?.();
	}

	end() {
		this.ended = true;
		this.wake?.();
	}

	/** The next URL, or null once the stream ended and all were taken. */
	async next(): Promise<string | null> {
		for (;;) {
			const url = this.urls.shift();
			if (url !== undefined) return url;
			if (this.ended) return null;
			await new Promise<void>((resolve) => {
				this.wake = () => {
					this.wake = null;
					resolve();
				};
			});
		}
	}
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

export function createSpeechPlayer(request: typeof fetch = (...args) => fetch(...args)) {
	let state = IDLE;
	const listeners = new Set<() => void>();
	const queue: SpeechItem[] = [];
	let running = false;
	let abort: AbortController | null = null;
	let audio: HTMLAudioElement | null = null;
	let rate = 1;

	const publish = (patch: Partial<SpeechPlayerState>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};

	const markStored = (chatId: string, key: string) => {
		const stored = new Map(state.stored);
		stored.set(chatId, new Set([...(stored.get(chatId) ?? []), key]));
		publish({ stored });
	};

	const element = (): HTMLAudioElement => {
		audio ??= new Audio();
		return audio;
	};

	/** Play one piece to its end (or until aborted). */
	const playPiece = (url: string, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			const el = element();
			const cleanup = () => {
				el.removeEventListener("ended", onEnded);
				el.removeEventListener("error", onError);
				signal.removeEventListener("abort", onAbort);
			};
			const onEnded = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("The audio could not be played."));
			};
			const onAbort = () => {
				cleanup();
				el.pause();
				reject(abortError());
			};
			if (signal.aborted) return onAbort();
			el.addEventListener("ended", onEnded);
			el.addEventListener("error", onError);
			signal.addEventListener("abort", onAbort, { once: true });
			el.src = url;
			el.playbackRate = rate;
			el.play().catch((error: unknown) => {
				if (signal.aborted) return;
				cleanup();
				reject(error instanceof Error ? error : new Error("The audio could not be played."));
			});
		});

	/** Read the NDJSON stream into the channel; resolves once it ends. */
	const readStream = async (res: Response, channel: PieceChannel) => {
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					const event = JSON.parse(line) as SpeechStreamEvent;
					if (event.type === "chunk") channel.push(event.url);
					else if (event.type === "error") throw new Error(event.message);
					else if (event.type === "done") return;
				}
			}
			throw new Error("Reading aloud was interrupted.");
		} finally {
			channel.end();
			reader.releaseLock();
		}
	};

	const speak = async (item: SpeechItem, controller: AbortController) => {
		const res = await request("/api/speech", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: item.chatId, text: item.text }),
			signal: controller.signal,
		});
		if (!res.ok || !res.body) {
			const detail = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(detail?.message ?? `Reading aloud failed (${res.status}).`);
		}
		const channel = new PieceChannel();
		// The stream and playback run side by side: the first piece plays
		// while the script is still being written.
		const reading = readStream(res, channel);
		reading.catch(() => {});
		for (let url = await channel.next(); url !== null; url = await channel.next()) {
			if (state.phase !== "playing") publish({ phase: "playing" });
			await playPiece(url, controller.signal);
		}
		await reading;
		markStored(item.chatId, item.key);
	};

	const pump = async () => {
		if (running) return;
		running = true;
		try {
			for (let item = queue.shift(); item; item = queue.shift()) {
				const controller = new AbortController();
				abort = controller;
				publish({ current: item, phase: "preparing", queued: queue.length, error: null });
				try {
					await speak(item, controller);
				} catch (error) {
					if (!controller.signal.aborted) {
						publish({ error: { chatId: item.chatId, message: error instanceof Error ? error.message : "Reading aloud failed." } });
					}
				} finally {
					if (abort === controller) abort = null;
				}
			}
		} finally {
			running = false;
			publish({ current: null, phase: "idle", queued: 0 });
		}
	};

	return {
		getSnapshot: () => state,
		getServerSnapshot: () => IDLE,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Queue one text behind whatever is being read. */
		enqueue(item: SpeechItem) {
			const duplicate = (other: SpeechItem | null) => other?.chatId === item.chatId && other.key === item.key;
			if (duplicate(state.current) || queue.some(duplicate)) return;
			queue.push(item);
			publish({ queued: running ? queue.length : 0 });
			void pump();
		},
		/** Stop reading and drop the queue. `chatId` limits it to one chat. */
		stop(chatId?: string) {
			if (chatId !== undefined && state.current?.chatId !== chatId && !queue.some((q) => q.chatId === chatId)) return;
			queue.length = 0;
			abort?.abort();
			audio?.pause();
			publish({ queued: 0 });
		},
		/** Listen again: stop everything, then read this one text. */
		replay(item: SpeechItem) {
			queue.length = 0;
			abort?.abort();
			audio?.pause();
			queue.push(item);
			void pump();
		},
		/** The playback rate for this and every later piece. */
		setRate(next: number) {
			rate = next;
			if (audio) audio.playbackRate = next;
		},
		/** Seed the stored set from the server (one chat's listing). */
		setStored(chatId: string, keys: readonly string[]) {
			const stored = new Map(state.stored);
			stored.set(chatId, new Set([...(stored.get(chatId) ?? []), ...keys]));
			publish({ stored });
		},
		dismissError() {
			publish({ error: null });
		},
	};
}

export type SpeechPlayer = ReturnType<typeof createSpeechPlayer>;

export const speechPlayer: SpeechPlayer = createSpeechPlayer();

/** Stop reading aloud (dictation start, chat unmount). */
export function stopSpeech(chatId?: string): void {
	speechPlayer.stop(chatId);
}

export function useSpeechPlayer(): SpeechPlayerState {
	return useSyncExternalStore(speechPlayer.subscribe, speechPlayer.getSnapshot, speechPlayer.getServerSnapshot);
}
