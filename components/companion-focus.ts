"use client";
/**
 * The desktop tells the server which session it shows; the iPad companion
 * follows it. Reports are ordered by a monotonic sequence so a late
 * "left chat A" can never overwrite "opened chat B".
 */

import { useEffect } from "react";

let seq = 0;

function report(chatId: string | null): void {
	seq = Math.max(seq + 1, Date.now());
	void fetch("/api/companion/admin/focus", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, seq }),
		keepalive: true,
	}).catch(() => { /* the companion is optional */ });
}

export function useCompanionFocus(chatId: string): void {
	useEffect(() => {
		report(chatId);
		// Another desktop window may have taken focus meanwhile.
		const onFocus = () => report(chatId);
		window.addEventListener("focus", onFocus);
		return () => {
			window.removeEventListener("focus", onFocus);
			report(null);
		};
	}, [chatId]);
}
