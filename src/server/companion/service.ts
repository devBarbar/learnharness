/**
 * The iPad companion service: the on/off switch (Tailscale serve + the
 * pairing token), the desktop's focused session the iPad follows, and the
 * last-seen heartbeat. Process state lives on globalThis so Next's dev
 * module reloading never forks it.
 */

import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { companionStore } from "../../store/companion.ts";
import { hashCompanionToken } from "./access.ts";
import {
	companionUrl,
	startTailscaleServe,
	stopTailscaleServe,
	tailscaleBinary,
	tailscaleIdentity,
	TailscaleError,
} from "./tailscale.ts";

interface CompanionRuntime {
	/** The plaintext token, kept in memory only so the QR can be shown again
	 *  while the app runs. After a restart a paired iPad keeps working; a new
	 *  QR needs "Pair again". */
	token: string | null;
	focus: { chatId: string | null; seq: number };
	lastSeenAt: string | null;
}

const RUNTIME_KEY = Symbol.for("learnharness.companion.runtime");
function runtime(): CompanionRuntime {
	const g = globalThis as unknown as Record<symbol, CompanionRuntime | undefined>;
	return (g[RUNTIME_KEY] ??= { token: null, focus: { chatId: null, seq: 0 }, lastSeenAt: null });
}

export interface CompanionStatus {
	enabled: boolean;
	tailscaleInstalled: boolean;
	url: string | null;
	/** Present only while the pairing token is in memory. */
	pairing: { link: string; qrSvg: string } | null;
	paired: boolean;
	lastSeenAt: string | null;
	focusChatId: string | null;
}

/** The local port tailscale serve proxies to: the port this server listens on. */
export function localServerPort(env: Record<string, string | undefined> = process.env): number {
	const port = Number(env.PORT ?? "3000");
	return Number.isSafeInteger(port) && port > 0 ? port : 3000;
}

async function pairingFor(url: string | undefined): Promise<CompanionStatus["pairing"]> {
	const token = runtime().token;
	if (!url || !token) return null;
	// The token rides the URL FRAGMENT: it never reaches a server log or
	// a Referer; the companion page moves it into local storage.
	const link = `${url}#k=${token}`;
	const qrSvg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
	return { link, qrSvg };
}

export async function companionStatus(): Promise<CompanionStatus> {
	const config = companionStore.readConfig();
	const rt = runtime();
	return {
		enabled: config.enabled,
		tailscaleInstalled: tailscaleBinary() !== null,
		url: config.url ?? null,
		pairing: config.enabled ? await pairingFor(config.url) : null,
		paired: config.enabled && Boolean(config.tokenHash),
		lastSeenAt: rt.lastSeenAt,
		focusChatId: rt.focus.chatId,
	};
}

function newToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Switch on: serve the companion on the tailnet and mint a fresh pairing
 *  token (switching off always invalidated the previous one). */
export async function enableCompanion(): Promise<CompanionStatus> {
	const identity = await tailscaleIdentity();
	await startTailscaleServe(localServerPort());
	const token = newToken();
	runtime().token = token;
	companionStore.writeConfig({
		enabled: true,
		tokenHash: hashCompanionToken(token),
		ownerLogin: identity.ownerLogin,
		url: companionUrl(identity),
		pairedAt: new Date().toISOString(),
	});
	return companionStatus();
}

/** Boot: a companion left ON keeps its pairing, but the serve entry must
 *  point at THIS launch's port (the desktop picks a free port per launch). */
export async function resumeCompanion(): Promise<void> {
	const config = companionStore.readConfig();
	if (!config.enabled) return;
	try {
		const identity = await tailscaleIdentity();
		await startTailscaleServe(localServerPort());
		const url = companionUrl(identity);
		if (url !== config.url || identity.ownerLogin !== config.ownerLogin) {
			companionStore.writeConfig({ ...config, url, ownerLogin: identity.ownerLogin });
		}
	} catch (err) {
		console.error("[companion] could not resume Tailscale serve:", err instanceof Error ? err.message : err);
	}
}

/** Switch off: remove our serve port and invalidate the pairing. */
export async function disableCompanion(): Promise<{ status: CompanionStatus; warning?: string }> {
	let warning: string | undefined;
	try {
		await stopTailscaleServe();
	} catch (err) {
		warning = err instanceof TailscaleError ? err.message : "Could not stop Tailscale serve.";
	}
	companionStore.writeConfig({ enabled: false });
	runtime().token = null;
	runtime().lastSeenAt = null;
	return { status: await companionStatus(), ...(warning ? { warning } : {}) };
}

/** Forget the paired iPad: a new token (the old one stops working at once). */
export async function repairCompanion(): Promise<CompanionStatus> {
	const config = companionStore.readConfig();
	if (!config.enabled) return companionStatus();
	const token = newToken();
	runtime().token = token;
	runtime().lastSeenAt = null;
	companionStore.writeConfig({ ...config, tokenHash: hashCompanionToken(token), pairedAt: new Date().toISOString() });
	return companionStatus();
}

/** The desktop reports the session it shows (seq orders racing reports). */
export function setCompanionFocus(chatId: string | null, seq: number): void {
	const rt = runtime();
	if (seq < rt.focus.seq) return;
	rt.focus = { chatId, seq };
}

export function companionFocus(): string | null {
	return runtime().focus.chatId;
}

export function noteCompanionSeen(): void {
	runtime().lastSeenAt = new Date().toISOString();
}
