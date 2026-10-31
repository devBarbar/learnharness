import type { Metadata, Viewport } from "next";
import "../../globals.css";

/** The iPad companion's own root layout: none of the desktop shell
 *  (sidebar, server events, activity dock) — the iPad only reaches the
 *  companion API (proxy.ts). */
export const metadata: Metadata = {
	title: "LearnHarness Notebook",
	appleWebApp: { capable: true, title: "Notebook", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: "cover",
	themeColor: "#141414",
};

export default function CompanionLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body className="min-h-dvh overscroll-none bg-background text-foreground antialiased">{children}</body>
		</html>
	);
}
