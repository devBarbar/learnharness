import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import {
	companionAuthorized,
	isCompanionApiPath,
	isRemoteRequest,
	remotePathAllowed,
} from "./src/server/companion/access.ts";
import { companionStore } from "./src/store/companion.ts";

function refuse(status: number, error: string) {
	return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Applies to every request (no matcher: remote requests must never reach
 * a page or asset outside the companion surface). Local requests keep the
 * original rule — every API method, including SSE and spending/settings
 * routes, needs the desktop capability. No public callback or worker
 * bypass: internal jobs call server functions, and any legitimate
 * self-HTTP request must carry the private capability.
 *
 * Remote requests (anything through `tailscale serve`) are confined to the
 * iPad companion: its page, static assets and companion API, the latter
 * gated by the pairing token and the owner's Tailscale identity. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (isRemoteRequest(request.headers, request.nextUrl.host)) {
		if (!remotePathAllowed(pathname)) return refuse(404, "Not found.");
		if (pathname.startsWith("/api/") && !companionAuthorized(request.headers, companionStore.readConfig(), true)) {
			return refuse(403, "This iPad is not paired with LearnHarness. Scan the pairing code in Settings → iPad companion.");
		}
		return NextResponse.next();
	}
	if (!pathname.startsWith("/api/")) return NextResponse.next();
	if (desktopAPIAuthorized(request.headers)) return NextResponse.next();
	// A paired companion on this same computer (e.g. testing in a local
	// browser) may still use the companion API with its token.
	if (isCompanionApiPath(pathname) && companionAuthorized(request.headers, companionStore.readConfig(), false)) {
		return NextResponse.next();
	}
	return refuse(403, "Desktop API access requires the trusted LearnHarness window.");
}

/** Everything except Next's immutable build assets (public by design). */
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
