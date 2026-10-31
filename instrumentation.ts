/** Server boot hook (Next calls register() once per server instance). */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "test") return;
	// iPad companion: a companion left switched on re-points its Tailscale
	// serve entry at this launch's port. Not awaited — boot never waits on
	// the Tailscale CLI.
	const { resumeCompanion } = await import("./src/server/companion/service.ts");
	void resumeCompanion();
}
