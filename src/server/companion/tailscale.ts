/**
 * Tailscale control for the iPad companion. The app itself keeps listening
 * on loopback only; `tailscale serve` terminates HTTPS on the tailnet and
 * proxies ONE dedicated port to it. We only ever add or remove our own
 * HTTPS port's entry — never `serve reset`, which would wipe the user's
 * other serve routes.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The tailnet HTTPS port the companion is served on. */
export const COMPANION_HTTPS_PORT = 8443;

export interface TailscaleIdentity {
	/** e.g. desktop-1dnvkh1.tail945cf5.ts.net (no trailing dot). */
	dnsName: string;
	/** The login of the user who owns this machine, e.g. someone@github. */
	ownerLogin: string;
}

export class TailscaleError extends Error {}

/** The CLI path: PATH first, then the standard install locations. */
export function tailscaleBinary(env: Record<string, string | undefined> = process.env): string | null {
	const exe = process.platform === "win32" ? "tailscale.exe" : "tailscale";
	const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
	const candidates = [
		...dirs.map((d) => path.join(d, exe)),
		...(process.platform === "win32"
			? [path.join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", exe)]
			: process.platform === "darwin"
				? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
				: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"]),
	];
	for (const c of candidates) {
		try {
			if (fs.statSync(/*turbopackIgnore: true*/ c).isFile()) return c;
		} catch { /* not here */ }
	}
	return null;
}

function run(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
	const bin = tailscaleBinary();
	if (!bin) return Promise.reject(new TailscaleError("Tailscale is not installed on this computer."));
	return new Promise((resolve, reject) => {
		// The CLI is an external binary, never part of the app payload: keep
		// the bundler's tracer from sweeping the whole project for it.
		execFile(/*turbopackIgnore: true*/ bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				const detail = (stderr || stdout || err.message).trim().split(/\r?\n/).slice(0, 4).join(" ");
				reject(new TailscaleError(`tailscale ${args[0]} failed: ${detail}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

/** Parse `tailscale status --json` (exported for tests). */
export function parseTailscaleStatus(json: string): TailscaleIdentity {
	let status: {
		BackendState?: string;
		Self?: { DNSName?: string; UserID?: number };
		User?: Record<string, { LoginName?: string }>;
	};
	try {
		status = JSON.parse(json);
	} catch {
		throw new TailscaleError("Could not read Tailscale's status.");
	}
	if (status.BackendState !== "Running") {
		throw new TailscaleError("Tailscale is not connected. Open Tailscale and sign in, then try again.");
	}
	const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
	const ownerLogin = status.Self?.UserID !== undefined ? status.User?.[String(status.Self.UserID)]?.LoginName : undefined;
	if (!dnsName || !ownerLogin) throw new TailscaleError("Tailscale did not report this computer's name and owner.");
	return { dnsName, ownerLogin };
}

export async function tailscaleIdentity(): Promise<TailscaleIdentity> {
	const { stdout } = await run(["status", "--json"]);
	return parseTailscaleStatus(stdout);
}

/** Serve https://<dnsName>:8443 → http://127.0.0.1:<localPort> on the tailnet. */
export async function startTailscaleServe(localPort: number): Promise<void> {
	if (!Number.isSafeInteger(localPort) || localPort <= 0 || localPort > 65535) {
		throw new TailscaleError(`Invalid local port: ${localPort}`);
	}
	await run(["serve", "--bg", `--https=${COMPANION_HTTPS_PORT}`, `http://127.0.0.1:${localPort}`], 30_000);
}

/** Remove ONLY the companion's port from the serve config. */
export async function stopTailscaleServe(): Promise<void> {
	await run(["serve", `--https=${COMPANION_HTTPS_PORT}`, "off"]);
}

export function companionUrl(identity: TailscaleIdentity): string {
	return `https://${identity.dnsName}:${COMPANION_HTTPS_PORT}/companion`;
}
