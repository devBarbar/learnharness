/**
 * THE COMPANION ACCESS GATE (proxy.ts). Two kinds of request reach the app:
 *
 * - LOCAL: the desktop window (or a browser on this computer) on loopback.
 *   Unchanged — the existing desktop capability check applies to /api.
 * - REMOTE: anything that arrived through `tailscale serve` (or any other
 *   non-loopback route). Remote requests may load ONLY the companion page,
 *   its static assets and the companion API — and the API additionally
 *   needs the companion switched on, the pairing token, and the Tailscale
 *   identity header of the computer's owner.
 *
 * The token is the real secret (256 bits, stored hashed); the owner-login
 * check keeps devices shared INTO the tailnet out even if they learn the
 * URL. Pure over (headers, path, config) so it is unit-tested directly.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { CompanionConfig } from "../../store/companion.ts";

export const COMPANION_TOKEN_HEADER = "x-learnharness-companion";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostName(host: string): string {
	if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
	return host.split(":")[0]!;
}

function loopbackAddress(value: string): boolean {
	const v = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return v === "127.0.0.1" || v === "::1" || v === "::ffff:127.0.0.1" || v.startsWith("127.") || v.startsWith("::ffff:127.");
}

/** Did this request arrive from outside this computer's loopback? Next
 *  itself stamps x-forwarded-* from the socket on EVERY request, so the
 *  test is the addresses they carry, not their presence: anything
 *  `tailscale serve` forwards carries the client's tailnet address, a
 *  *.ts.net host and (for user devices) the Tailscale identity headers. */
export function isRemoteRequest(headers: Headers, urlHost?: string): boolean {
	if (headers.has("tailscale-user-login") || headers.has("tailscale-user-name")) return true;
	const forwardedFor = headers.get("x-forwarded-for");
	if (forwardedFor && forwardedFor.split(",").some((ip) => !loopbackAddress(ip))) return true;
	for (const value of [headers.get("x-forwarded-host"), headers.get("host") ?? urlHost]) {
		if (value === null || value === undefined) continue;
		if (!LOOPBACK_HOSTS.has(hostName(value.trim().toLowerCase()))) return true;
	}
	return !headers.get("host") && !urlHost;
}

/** The companion API surface the iPad may call (admin routes are desktop-only). */
export function isCompanionApiPath(pathname: string): boolean {
	return pathname.startsWith("/api/companion/") && !pathname.startsWith("/api/companion/admin/");
}

/** What a REMOTE request may load at all (the API still needs the token). */
export function remotePathAllowed(pathname: string): boolean {
	return (
		pathname === "/companion" ||
		pathname.startsWith("/companion/") ||
		pathname.startsWith("/_next/") ||
		pathname === "/favicon.ico" ||
		pathname === "/companion.webmanifest" ||
		pathname.startsWith("/companion-icon") ||
		isCompanionApiPath(pathname)
	);
}

export function hashCompanionToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A companion API request's credentials, checked against the switch. */
export function companionAuthorized(headers: Headers, config: CompanionConfig, remote: boolean): boolean {
	if (!config.enabled || !config.tokenHash) return false;
	const token = headers.get(COMPANION_TOKEN_HEADER);
	if (!token || token.length < 32 || token.length > 256) return false;
	const actual = Buffer.from(hashCompanionToken(token));
	const wanted = Buffer.from(config.tokenHash);
	if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
	if (remote) {
		// Through tailscale serve: only the computer owner's own devices.
		const login = headers.get("tailscale-user-login");
		if (!config.ownerLogin || !login || login.toLowerCase() !== config.ownerLogin.toLowerCase()) return false;
	}
	return true;
}
