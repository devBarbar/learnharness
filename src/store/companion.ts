/**
 * The iPad companion's persisted switch (data/companion.json): whether it
 * is on, the pairing token's HASH (never the token), the Tailscale owner
 * login requests must carry, and the companion URL. Read on every proxied
 * remote request, so reads are mtime-cached.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";

export interface CompanionConfig {
	enabled: boolean;
	/** sha256 hex of the pairing token. */
	tokenHash?: string;
	/** The Tailscale login that owns this computer, captured at enable. */
	ownerLogin?: string;
	url?: string;
	pairedAt?: string;
}

const DISABLED: CompanionConfig = { enabled: false };

function file(): string {
	return path.join(PATHS.data, "companion.json");
}

let cache: { mtimeMs: number; config: CompanionConfig } | null = null;

function readConfig(): CompanionConfig {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file());
	} catch {
		cache = null;
		return DISABLED;
	}
	if (cache && cache.mtimeMs === stat.mtimeMs) return cache.config;
	try {
		const parsed = JSON.parse(fs.readFileSync(file(), "utf-8")) as Partial<CompanionConfig>;
		const config: CompanionConfig = {
			enabled: parsed.enabled === true,
			...(typeof parsed.tokenHash === "string" ? { tokenHash: parsed.tokenHash } : {}),
			...(typeof parsed.ownerLogin === "string" ? { ownerLogin: parsed.ownerLogin } : {}),
			...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
			...(typeof parsed.pairedAt === "string" ? { pairedAt: parsed.pairedAt } : {}),
		};
		cache = { mtimeMs: stat.mtimeMs, config };
		return config;
	} catch {
		return DISABLED; // unreadable = off (fail closed)
	}
}

function writeConfig(config: CompanionConfig): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	const tmp = `${file()}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, "\t"), { mode: 0o600 });
	fs.renameSync(tmp, file());
	cache = null;
}

export const companionStore = { readConfig, writeConfig };
