"use client";

/**
 * Read-aloud in the chat (speech wave, 2026-11-08):
 *
 *   useAutoRead     — queues every NEW tutor text once it is complete
 *                     (automatic only, owner decision; texts present at
 *                     mount, or arriving while reading is off, are never
 *                     read later).
 *   SpeechStrip     — the quiet status line above the composer: what is
 *                     being read, Stop, and a failure notice.
 *   ListenAgain     — the per-text button for texts with stored audio.
 *
 * Only tutor messages are read — question, quiz and problem cards are not
 * text parts and never reach the queue (owner decision).
 */

import { useEffect, useRef } from "react";
import { LoaderIcon, SquareIcon, Volume2Icon, XIcon } from "lucide-react";
import { speechKey, type LhViewMessage } from "@/src/core";
import { speechPlayer, useSpeechPlayer } from "@/components/speech-player";
import { useSpeechSettings } from "@/components/speech-preference";

/** The tutor texts in view order, each with whether it is complete: a
 *  text is final once anything follows it, or once the turn is idle. */
export function tutorTexts(messages: readonly LhViewMessage[], running: boolean): Array<{ text: string; final: boolean }> {
	const flat: Array<{ text?: string; isText: boolean }> = [];
	for (const m of messages) {
		for (const part of m.parts) {
			flat.push({ text: part.text, isText: m.role === "assistant" && part.type === "text" });
		}
	}
	const out: Array<{ text: string; final: boolean }> = [];
	flat.forEach((p, i) => {
		if (!p.isText || !p.text?.trim()) return;
		out.push({ text: p.text, final: !running || i < flat.length - 1 });
	});
	return out;
}

export function useAutoRead({ chatId, messages, running }: { chatId: string; messages: readonly LhViewMessage[]; running: boolean }) {
	const settings = useSpeechSettings();
	const stored = useSpeechPlayer().stored.get(chatId);
	const listed = useRef(false);
	// Texts already on screen at mount are history — never auto-read.
	const seen = useRef<Set<string> | null>(null);
	if (seen.current === null) {
		seen.current = new Set(tutorTexts(messages, false).map((t) => speechKey(t.text)));
	}

	// The stored set, once per mount (the "listen again" buttons, and
	// the guard against re-reading a replayed in-flight turn).
	useEffect(() => {
		let cancelled = false;
		void fetch(`/api/speech/${encodeURIComponent(chatId)}`)
			.then((res) => (res.ok ? (res.json() as Promise<{ keys?: string[] }>) : { keys: [] }))
			.catch(() => ({ keys: [] as string[] }))
			.then((body) => {
				if (cancelled) return;
				speechPlayer.setStored(chatId, body.keys ?? []);
				listed.current = true;
			});
		return () => {
			cancelled = true;
		};
	}, [chatId]);

	useEffect(() => {
		speechPlayer.setRate(settings.speed);
	}, [settings.speed]);

	// Switching reading off stops it; leaving the chat stops it.
	useEffect(() => {
		if (settings.loaded && !settings.autoRead) speechPlayer.stop(chatId);
	}, [settings.loaded, settings.autoRead, chatId]);
	useEffect(() => () => speechPlayer.stop(chatId), [chatId]);

	useEffect(() => {
		if (!settings.loaded || !listed.current) return;
		for (const t of tutorTexts(messages, running)) {
			if (!t.final) continue;
			const key = speechKey(t.text);
			if (seen.current!.has(key)) continue;
			seen.current!.add(key);
			if (!settings.autoRead || stored?.has(key)) continue;
			speechPlayer.enqueue({ chatId, key, text: t.text });
		}
	}, [messages, running, chatId, settings.loaded, settings.autoRead, stored]);
}

export function SpeechStrip({ chatId }: { chatId: string }) {
	const player = useSpeechPlayer();
	const mine = player.current?.chatId === chatId;
	const error = player.error?.chatId === chatId ? player.error.message : null;
	if (!mine && !error) return null;
	return (
		<div className="pointer-events-auto flex items-center justify-end gap-2 pb-1 pr-4 font-ui text-[11px] text-muted-foreground/70" data-testid="speech-strip">
			{mine && (
				<>
					{player.phase === "preparing" ? <LoaderIcon className="size-3 animate-spin" /> : <Volume2Icon className="size-3" />}
					<span>
						{player.phase === "preparing" ? "Preparing to read aloud…" : "Reading aloud"}
						{player.queued > 0 ? ` · ${player.queued} more queued` : ""}
					</span>
					<button
						type="button"
						onClick={() => speechPlayer.stop()}
						className="flex cursor-pointer items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-foreground transition-colors hover:bg-accent"
						data-testid="speech-stop"
					>
						<SquareIcon className="size-2.5 fill-current" />
						Stop
					</button>
				</>
			)}
			{!mine && error && (
				<>
					<span className="max-w-[420px] truncate text-red-500/80" title={error}>
						Read aloud failed: {error}
					</span>
					<button
						type="button"
						onClick={() => speechPlayer.dismissError()}
						aria-label="Dismiss"
						className="cursor-pointer rounded-sm p-0.5 hover:bg-accent"
					>
						<XIcon className="size-3" />
					</button>
				</>
			)}
		</div>
	);
}

/** "Listen again" for one tutor text — shown only once its audio is stored. */
export function ListenAgain({ chatId, text }: { chatId: string; text: string }) {
	const player = useSpeechPlayer();
	const key = speechKey(text);
	const playing = player.current?.chatId === chatId && player.current.key === key;
	if (!playing && !player.stored.get(chatId)?.has(key)) return null;
	return (
		<div className="mt-1 flex">
			<button
				type="button"
				onClick={() => (playing ? speechPlayer.stop() : speechPlayer.replay({ chatId, key, text }))}
				className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 font-ui text-[11px] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
				data-testid="speech-listen-again"
			>
				{playing ? <SquareIcon className="size-2.5 fill-current" /> : <Volume2Icon className="size-3" />}
				{playing ? "Stop" : "Listen again"}
			</button>
		</div>
	);
}
