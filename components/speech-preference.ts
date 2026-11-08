"use client";

/**
 * The read-aloud settings as the chat sees them (speech wave, 2026-11-08):
 * one window-lifetime read of GET /api/settings, re-read whenever a writer
 * lands the speech section (the settings-signal contract). Until the read
 * completes, reading is OFF — nothing is spoken on a guess.
 */

import { useSyncExternalStore } from "react";
import { FACTORY_SETTINGS, sanitizeUserSettings, type SpeechSettings, type UserSettings } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

export type EffectiveSpeech = Required<SpeechSettings> & { loaded: boolean };

const INITIAL: EffectiveSpeech = { ...FACTORY_SETTINGS.speech, autoRead: false, loaded: false };

let snapshot = INITIAL;
const listeners = new Set<() => void>();
let readers = 0;
let stopSignals: (() => void) | undefined;
let revision = 0;

function resolve(record: UserSettings | null): EffectiveSpeech {
	const speech = record?.speech ?? {};
	return {
		autoRead: speech.autoRead ?? FACTORY_SETTINGS.speech.autoRead,
		voice: speech.voice ?? FACTORY_SETTINGS.speech.voice,
		speed: speech.speed ?? FACTORY_SETTINGS.speech.speed,
		instructions: speech.instructions ?? FACTORY_SETTINGS.speech.instructions,
		loaded: true,
	};
}

async function load(): Promise<void> {
	const version = ++revision;
	try {
		const res = await fetch("/api/settings");
		if (!res.ok) return;
		const body = (await res.json()) as { settings: unknown };
		if (version !== revision) return;
		snapshot = resolve(sanitizeUserSettings(body.settings));
		for (const listener of listeners) listener();
	} catch {
		// Keep the last confirmed view (initially: reading off).
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "speech") void load();
		});
		if (!snapshot.loaded) void load();
	}
	return () => {
		listeners.delete(listener);
		if (--readers === 0) {
			stopSignals?.();
			stopSignals = undefined;
		}
	};
}

export function useSpeechSettings(): EffectiveSpeech {
	return useSyncExternalStore(subscribe, () => snapshot, () => INITIAL);
}
