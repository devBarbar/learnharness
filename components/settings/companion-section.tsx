"use client";
/**
 * Settings → iPad companion: the on/off switch (Tailscale serve + pairing),
 * the pairing QR, and the connection status. The iPad opens the QR's link,
 * which carries the pairing token in its fragment.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

interface CompanionStatus {
	enabled: boolean;
	tailscaleInstalled: boolean;
	url: string | null;
	pairing: { link: string; qrSvg: string } | null;
	paired: boolean;
	lastSeenAt: string | null;
	focusChatId: string | null;
}

function seenText(lastSeenAt: string | null): string {
	if (!lastSeenAt) return "Not connected yet";
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(lastSeenAt)) / 1000));
	if (seconds < 15) return "iPad connected";
	if (seconds < 120) return `iPad last seen ${seconds}s ago`;
	return `iPad last seen ${Math.round(seconds / 60)} min ago`;
}

export function CompanionSection() {
	const [status, setStatus] = useState<CompanionStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await fetch("/api/companion/admin/status", { cache: "no-store" }).catch(() => null);
		if (res?.ok) setStatus(await res.json() as CompanionStatus);
	}, []);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => clearInterval(timer);
	}, [load]);

	const act = async (path: "enable" | "disable" | "repair") => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/companion/admin/${path}`, { method: "POST" });
			const body = await res.json().catch(() => null) as (CompanionStatus & { error?: string; status?: CompanionStatus; warning?: string }) | null;
			if (!res.ok) {
				setError(body?.error ?? `Request failed (${res.status}).`);
				return;
			}
			if (body?.status) {
				setStatus(body.status);
				if (body.warning) setError(body.warning);
			} else if (body) setStatus(body);
		} finally {
			setBusy(false);
		}
	};

	if (!status) return <p className="text-xs text-muted-foreground/70">Loading…</p>;

	return (
		<div data-testid="companion-section" className="flex flex-col gap-3">
			<SettingsRow
				label="iPad companion"
				hint={status.tailscaleInstalled
					? "Write and sketch in a notebook on your iPad. Pages that changed are attached to every answer you send."
					: "Requires Tailscale on this computer and on the iPad."}
				dimmed={!status.tailscaleInstalled && !status.enabled}
			>
				<span className="flex items-center gap-2">
					{busy && <BrailleSpinner />}
					<Toggle
						checked={status.enabled}
						disabled={busy || (!status.tailscaleInstalled && !status.enabled)}
						label="iPad companion"
						onChange={(on) => void act(on ? "enable" : "disable")}
					/>
				</span>
			</SettingsRow>

			{error && (
				<p role="alert" data-testid="companion-error" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
					{error}
				</p>
			)}

			{status.enabled && (
				<SettingsGroup label="Pairing">
					{status.pairing ? (
						<div className="flex items-start gap-4">
							<div
								data-testid="companion-qr"
								className="size-40 shrink-0 rounded-sm bg-white p-1 [&>svg]:size-full"
								// Server-generated SVG from the qrcode library (no user content).
								dangerouslySetInnerHTML={{ __html: status.pairing.qrSvg }}
							/>
							<div className="min-w-0 text-xs text-muted-foreground">
								<p>Scan with the iPad&apos;s camera, open the link in Safari, then choose Share → Add to Home Screen.</p>
								<p className="mt-2">The iPad must be signed in to Tailscale with the same account as this computer.</p>
							</div>
						</div>
					) : (
						<p className="text-xs text-muted-foreground">
							{status.paired
								? "An iPad is paired. To pair another device, pair again; the current iPad will stop working."
								: "No pairing code yet."}
						</p>
					)}
					<SettingsRow label={seenText(status.lastSeenAt)} hint={status.url ?? undefined}>
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void act("repair")}>
							{status.pairing ? "New code" : "Pair again"}
						</Button>
					</SettingsRow>
				</SettingsGroup>
			)}
		</div>
	);
}
