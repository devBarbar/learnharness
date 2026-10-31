"use client";
/**
 * The iPad companion notebook (/companion). Always-on scratch pages for the
 * session the desktop shows: Apple Pencil ink (fingers scroll, so a resting
 * palm never draws), camera photos of paper notes, autosave to the desktop.
 * Pages that changed since the last answer ride along with the next answer
 * sent from either device; free-form questions and practice problems can
 * also be answered right here (transcribe → check → send).
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
	PAGE_HEIGHT,
	PAGE_WIDTH,
	drawPage,
	drawStroke,
	eraseAt,
	exportPagePng,
	newPageId,
	parseStrokes,
	photoToJpeg,
	serializeStrokes,
	type InkTool,
	type Stroke,
} from "./ink.ts";

const TOKEN_KEY = "lh-companion-token";
const TOKEN_HEADER = "x-learnharness-companion";
const POLL_MS = 2000;
const SAVE_DELAY_MS = 800;

type Prompt =
	| { type: "question"; toolCallId: string; tool: string; question: string; details?: string; freeForm: boolean }
	| { type: "problem"; problemCallId: string; statement: string };

interface ServerPage {
	id: string;
	kind: "ink" | "photo";
	version: number;
	sentVersion: number;
	hasContent: boolean;
	ext: "png" | "jpg";
}

interface CompanionState {
	chatId: string | null;
	title: string | null;
	kind: "teach" | "practice" | null;
	busy: boolean;
	prompt: Prompt | null;
	pages: ServerPage[];
}

interface Page extends ServerPage {
	strokes: Stroke[];
	photoUrl?: string;
	dirty: boolean;
}

type Connection = "connecting" | "ok" | "unpaired" | "offline";

const COLORS = [
	{ name: "Black", value: "#1a1a1a" },
	{ name: "Blue", value: "#1d4ed8" },
	{ name: "Red", value: "#dc2626" },
	{ name: "Green", value: "#15803d" },
];
const HIGHLIGHT = "#facc15";
const WIDTHS = [3, 5, 9];

function readToken(): string | null {
	if (typeof window === "undefined") return null;
	const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("k");
	if (fromHash) {
		localStorage.setItem(TOKEN_KEY, fromHash);
		// Drop the secret from the address bar (and from home-screen bookmarks).
		history.replaceState(null, "", window.location.pathname);
		return fromHash;
	}
	return localStorage.getItem(TOKEN_KEY);
}

export function NotebookApp() {
	const [token, setToken] = useState<string | null>(null);
	const [connection, setConnection] = useState<Connection>("connecting");
	const [state, setState] = useState<CompanionState | null>(null);
	const [pages, setPages] = useState<Page[]>([]);
	const [current, setCurrent] = useState(0);
	const [tool, setTool] = useState<InkTool | "eraser">("pen");
	const [color, setColor] = useState(COLORS[0]!.value);
	const [width, setWidth] = useState(WIDTHS[1]!);
	const [fingerDraws, setFingerDraws] = useState(false);
	const [promptOpen, setPromptOpen] = useState(true);
	const [answer, setAnswer] = useState<{ text: string; busy: "transcribing" | "sending" | null; error: string | null } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const tokenRef = useRef<string | null>(null);
	const loadedChat = useRef<string | null>(null);
	const pagesRef = useRef<Page[]>([]);
	const undo = useRef(new Map<string, Stroke[][]>());
	const redo = useRef(new Map<string, Stroke[][]>());
	const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const saving = useRef(new Map<string, Promise<void>>());
	const photoInput = useRef<HTMLInputElement>(null);

	useEffect(() => { pagesRef.current = pages; }, [pages]);

	const api = useCallback(async (path: string, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		if (tokenRef.current) headers.set(TOKEN_HEADER, tokenRef.current);
		if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
		const res = await fetch(path, { ...init, headers, cache: "no-store" });
		if (res.status === 403) setConnection("unpaired");
		return res;
	}, []);

	// ─── loading a session's notebook ──────────────────────────────────────
	const loadNotebook = useCallback(async (s: CompanionState) => {
		for (const p of pagesRef.current) if (p.photoUrl) URL.revokeObjectURL(p.photoUrl);
		undo.current.clear();
		redo.current.clear();
		const loaded: Page[] = await Promise.all(s.pages.map(async (p): Promise<Page> => {
			if (p.kind === "ink") {
				const res = await api(`/api/companion/page?chatId=${encodeURIComponent(s.chatId!)}&pageId=${p.id}`);
				const body = res.ok ? await res.json() as { strokes: string | null } : { strokes: null };
				return { ...p, strokes: parseStrokes(body.strokes), dirty: false };
			}
			const res = await api(`/api/companion/file?chatId=${encodeURIComponent(s.chatId!)}&file=${p.id}-v${p.version}.${p.ext}`);
			return { ...p, strokes: [], dirty: false, ...(res.ok ? { photoUrl: URL.createObjectURL(await res.blob()) } : {}) };
		}));
		if (loaded.length === 0) loaded.push(blankPage());
		loadedChat.current = s.chatId;
		setPages(loaded);
		setCurrent(0);
	}, [api]);

	// ─── polling the desktop ───────────────────────────────────────────────
	useEffect(() => {
		tokenRef.current = readToken();
		setToken(tokenRef.current);
		if (!tokenRef.current) {
			setConnection("unpaired");
			return;
		}
		let live = true;
		const poll = async () => {
			if (document.visibilityState !== "visible") return;
			try {
				const res = await api("/api/companion/state");
				if (!live || res.status === 403) return;
				if (!res.ok) { setConnection("offline"); return; }
				const next = await res.json() as CompanionState;
				setConnection("ok");
				setState(next);
				if (next.chatId !== loadedChat.current) {
					if (next.chatId) await loadNotebook(next);
					else { loadedChat.current = null; setPages([]); }
				} else {
					// Server truth for versions (answers mark pages sent).
					setPages((prev) => prev.map((p) => {
						const sp = next.pages.find((x) => x.id === p.id);
						return sp && !p.dirty ? { ...p, version: sp.version, sentVersion: sp.sentVersion } : p;
					}));
				}
			} catch {
				if (live) setConnection("offline");
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), POLL_MS);
		const onVisible = () => void poll();
		document.addEventListener("visibilitychange", onVisible);
		return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
	}, [api, loadNotebook]);

	// ─── saving ────────────────────────────────────────────────────────────
	const savePage = useCallback(async (pageId: string): Promise<void> => {
		const chatId = loadedChat.current;
		const page = pagesRef.current.find((p) => p.id === pageId);
		if (!chatId || !page || page.kind !== "ink" || !page.dirty) return;
		const strokes = page.strokes;
		const body = JSON.stringify({
			chatId,
			pageId,
			kind: "ink",
			hasContent: strokes.length > 0,
			image: exportPagePng(strokes),
			strokes: serializeStrokes(strokes),
		});
		const run = (async () => {
			const res = await api("/api/companion/page", { method: "PUT", body });
			if (!res.ok) {
				const detail = await res.json().catch(() => null) as { error?: string } | null;
				setNotice(detail?.error ?? "Saving failed. It will retry on your next stroke.");
				return;
			}
			const { page: saved } = await res.json() as { page: ServerPage };
			setPages((prev) => prev.map((p) => p.id === pageId
				? { ...p, version: saved.version, sentVersion: saved.sentVersion, hasContent: saved.hasContent, dirty: p.strokes !== strokes }
				: p));
			setNotice(null);
		})();
		saving.current.set(pageId, run);
		try { await run; } finally { if (saving.current.get(pageId) === run) saving.current.delete(pageId); }
	}, [api]);

	const scheduleSave = useCallback((pageId: string) => {
		const timers = saveTimers.current;
		clearTimeout(timers.get(pageId));
		timers.set(pageId, setTimeout(() => { timers.delete(pageId); void savePage(pageId); }, SAVE_DELAY_MS));
	}, [savePage]);

	/** Save everything now (before transcribing or answering). */
	const flushSaves = useCallback(async () => {
		for (const [pageId, timer] of saveTimers.current) {
			clearTimeout(timer);
			saveTimers.current.delete(pageId);
			await savePage(pageId);
		}
		await Promise.all(saving.current.values());
	}, [savePage]);

	// ─── editing ───────────────────────────────────────────────────────────
	const page = pages[current];

	const setStrokes = useCallback((pageId: string, strokes: Stroke[], recordUndo: boolean) => {
		if (recordUndo) {
			const before = pagesRef.current.find((p) => p.id === pageId)?.strokes ?? [];
			const stack = undo.current.get(pageId) ?? [];
			stack.push(before);
			if (stack.length > 200) stack.shift();
			undo.current.set(pageId, stack);
			redo.current.delete(pageId);
		}
		setPages((prev) => {
			const next = prev.map((p) => p.id === pageId ? { ...p, strokes, dirty: true } : p);
			pagesRef.current = next;
			return next;
		});
		scheduleSave(pageId);
	}, [scheduleSave]);

	const step = (from: Map<string, Stroke[][]>, to: Map<string, Stroke[][]>) => {
		if (!page) return;
		const stack = from.get(page.id);
		const prev = stack?.pop();
		if (!prev) return;
		to.set(page.id, [...(to.get(page.id) ?? []), page.strokes]);
		setStrokes(page.id, prev, false);
	};

	const addPage = () => {
		setPages((prev) => [...prev, blankPage()]);
		setCurrent(pages.length);
	};

	const deletePage = async () => {
		if (!page || !loadedChat.current) return;
		if (!confirm(`Delete page ${current + 1}? Pages already sent with an answer stay in that answer.`)) return;
		clearTimeout(saveTimers.current.get(page.id));
		saveTimers.current.delete(page.id);
		if (page.version > 0) await api(`/api/companion/page?chatId=${encodeURIComponent(loadedChat.current)}&pageId=${page.id}`, { method: "DELETE" });
		if (page.photoUrl) URL.revokeObjectURL(page.photoUrl);
		setPages((prev) => {
			const next = prev.filter((p) => p.id !== page.id);
			return next.length > 0 ? next : [blankPage()];
		});
		setCurrent((c) => Math.max(0, Math.min(c, pages.length - 2)));
	};

	const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		const chatId = loadedChat.current;
		if (!file || !chatId) return;
		setNotice("Adding photo…");
		try {
			const image = await photoToJpeg(file);
			const pageId = newPageId();
			const res = await api("/api/companion/page", { method: "PUT", body: JSON.stringify({ chatId, pageId, kind: "photo", hasContent: true, image }) });
			if (!res.ok) {
				const detail = await res.json().catch(() => null) as { error?: string } | null;
				setNotice(detail?.error ?? "The photo could not be added.");
				return;
			}
			const { page: saved } = await res.json() as { page: ServerPage };
			setPages((prev) => [...prev, { ...saved, strokes: [], dirty: false, photoUrl: URL.createObjectURL(file) }]);
			setCurrent(pagesRef.current.length);
			setNotice(null);
		} catch {
			setNotice("The photo could not be read.");
		}
	};

	// ─── answering from the notebook ───────────────────────────────────────
	const prompt = state?.prompt ?? null;
	const answerable = prompt !== null && (prompt.type === "problem" || prompt.freeForm);
	const answerTarget = prompt?.type === "question" ? prompt.toolCallId : prompt?.type === "problem" ? prompt.problemCallId : null;

	const transcribe = async () => {
		setAnswer((a) => ({ text: a?.text ?? "", busy: "transcribing", error: null }));
		await flushSaves();
		const ids = new Set(pagesRef.current.filter((p) => p.hasContent && p.version > p.sentVersion).map((p) => p.id));
		if (page?.hasContent) ids.add(page.id);
		const pageIds = pagesRef.current.filter((p) => ids.has(p.id)).map((p) => p.id);
		const res = await api("/api/companion/transcribe", { method: "POST", body: JSON.stringify({ chatId: loadedChat.current, pageIds }) });
		const body = await res.json().catch(() => null) as { text?: string; error?: string } | null;
		setAnswer((a) => res.ok
			? { text: body?.text ?? "", busy: null, error: null }
			: { text: a?.text ?? "", busy: null, error: body?.error ?? "Transcription failed." });
	};

	const send = async () => {
		if (!answer || !answerTarget) return;
		setAnswer({ ...answer, busy: "sending", error: null });
		await flushSaves();
		const res = await api("/api/companion/answer", {
			method: "POST",
			body: JSON.stringify({ chatId: loadedChat.current, target: answerTarget, text: answer.text }),
		});
		const body = await res.json().catch(() => null) as { error?: string } | null;
		if (!res.ok) {
			setAnswer((a) => a && { ...a, busy: null, error: body?.error ?? "The answer could not be sent." });
			return;
		}
		setAnswer(null);
		setNotice("Answer sent. The teacher is responding on the desktop.");
		setTimeout(() => setNotice(null), 4000);
	};

	// ─── render ────────────────────────────────────────────────────────────
	if (connection === "unpaired" || !token) {
		return (
			<Centered>
				<h1 className="text-lg">Not paired</h1>
				<p className="mt-2 max-w-md text-sm text-muted-foreground">
					On your computer, open LearnHarness → Settings → iPad companion, switch it on, and scan the code with this iPad&apos;s camera.
				</p>
			</Centered>
		);
	}

	const changedCount = pages.filter((p) => p.hasContent && (p.dirty || p.version > p.sentVersion)).length;

	return (
		<div className="flex h-dvh flex-col select-none [-webkit-touch-callout:none]" style={{ paddingTop: "env(safe-area-inset-top)" }}>
			{/* Header: session + current prompt */}
			<header className="shrink-0 border-b border-border px-4 py-2">
				<div className="flex items-center gap-2 font-ui text-xs">
					<span className={`size-2 rounded-full ${connection === "ok" ? "bg-green-500" : connection === "offline" ? "bg-red-500" : "bg-yellow-500"}`} />
					<span className="min-w-0 flex-1 truncate text-muted-foreground">
						{connection === "offline" ? "Can't reach your computer" : state?.title ?? "No session open on the desktop"}
					</span>
					{state?.busy && <span className="text-muted-foreground">Teacher is responding…</span>}
					<span className="text-muted-foreground">
						{changedCount > 0 ? `${changedCount} page${changedCount === 1 ? "" : "s"} will be sent with your next answer` : "Nothing new to send"}
					</span>
				</div>
				{prompt && (
					<div className="mt-2 rounded-lg border border-border bg-card px-3 py-2">
						<button type="button" onClick={() => setPromptOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-xs uppercase tracking-wide text-muted-foreground">
							<span className="flex-1">
								{prompt.type === "problem" ? "Problem" : prompt.freeForm ? "Question — answer here or on the desktop" : "Multiple choice — answer on the desktop"}
							</span>
							<span>{promptOpen ? "▴" : "▾"}</span>
						</button>
						{promptOpen && (
							<p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-prose text-[15px] leading-snug">
								{prompt.type === "problem" ? prompt.statement : prompt.question}
								{prompt.type === "question" && prompt.details ? `\n\n${prompt.details}` : ""}
							</p>
						)}
						{answerable && !state?.busy && (
							<button
								type="button"
								onClick={() => { setAnswer({ text: "", busy: null, error: null }); void transcribe(); }}
								className="mt-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
							>
								Answer from notebook
							</button>
						)}
					</div>
				)}
			</header>

			{/* Toolbar */}
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2 font-ui text-xs">
				{COLORS.map((c) => (
					<ToolButton key={c.value} label={c.name} active={tool === "pen" && color === c.value} onClick={() => { setTool("pen"); setColor(c.value); }}>
						<span className="block size-4 rounded-full" style={{ background: c.value, boxShadow: "0 0 0 1px #fff3" }} />
					</ToolButton>
				))}
				<ToolButton label="Highlighter" active={tool === "highlighter"} onClick={() => setTool("highlighter")}>
					<span className="block h-3 w-5 rounded-sm" style={{ background: HIGHLIGHT, opacity: 0.7 }} />
				</ToolButton>
				<ToolButton label="Eraser" active={tool === "eraser"} onClick={() => setTool("eraser")}>Erase</ToolButton>
				<span className="mx-1 h-5 w-px bg-border" />
				{WIDTHS.map((w) => (
					<ToolButton key={w} label={`Width ${w}`} active={width === w} onClick={() => setWidth(w)}>
						<span className="block rounded-full bg-foreground" style={{ width: w + 3, height: w + 3 }} />
					</ToolButton>
				))}
				<span className="mx-1 h-5 w-px bg-border" />
				<ToolButton label="Undo" onClick={() => step(undo.current, redo.current)}>Undo</ToolButton>
				<ToolButton label="Redo" onClick={() => step(redo.current, undo.current)}>Redo</ToolButton>
				<span className="mx-1 h-5 w-px bg-border" />
				<ToolButton label="Finger drawing" active={fingerDraws} onClick={() => setFingerDraws((f) => !f)}>Finger</ToolButton>
				<span className="flex-1" />
				<ToolButton label="Add photo" onClick={() => photoInput.current?.click()} disabled={!loadedChat.current}>Photo</ToolButton>
				<ToolButton label="New page" onClick={addPage} disabled={!loadedChat.current}>New page</ToolButton>
				<ToolButton label="Delete page" onClick={() => void deletePage()} disabled={!page}>Delete</ToolButton>
				<input ref={photoInput} type="file" accept="image/*" className="hidden" onChange={(e) => void onPhoto(e)} />
			</div>

			{/* Page tabs */}
			{pages.length > 0 && (
				<div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-1.5 font-ui text-xs">
					{pages.map((p, i) => {
						const changed = p.hasContent && (p.dirty || p.version > p.sentVersion);
						return (
							<button
								key={p.id}
								type="button"
								onClick={() => setCurrent(i)}
								className={`flex items-center gap-1 rounded-sm px-2.5 py-1 ${i === current ? "bg-accent text-foreground" : "text-muted-foreground"}`}
							>
								{p.kind === "photo" ? `Photo ${i + 1}` : `Page ${i + 1}`}
								{changed && <span title="Changed since your last answer" className="size-1.5 rounded-full bg-blue-400" />}
							</button>
						);
					})}
				</div>
			)}

			{notice && <p className="shrink-0 bg-accent px-4 py-1.5 text-xs text-foreground">{notice}</p>}

			{/* The page */}
			<main className="min-h-0 flex-1 overflow-y-auto bg-neutral-800 p-3">
				{!loadedChat.current ? (
					<Centered>
						<p className="text-sm text-muted-foreground">Open a session on the desktop. Its notebook will appear here.</p>
					</Centered>
				) : page?.kind === "photo" ? (
					// eslint-disable-next-line @next/next/no-img-element -- blob URL
					<img src={page.photoUrl} alt={`Photo page ${current + 1}`} className="mx-auto w-full max-w-[1100px] rounded-sm bg-white" />
				) : page ? (
					<InkSurface
						key={page.id}
						strokes={page.strokes}
						tool={tool}
						color={tool === "highlighter" ? HIGHLIGHT : color}
						width={tool === "highlighter" ? 26 : width}
						fingerDraws={fingerDraws}
						onChange={(strokes, recordUndo) => setStrokes(page.id, strokes, recordUndo)}
					/>
				) : null}
			</main>

			{answer && (
				<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
					<div className="w-full max-w-2xl rounded-xl border border-border bg-card p-4">
						<h2 className="font-ui text-sm uppercase tracking-widest">Your answer</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							Check the transcription and fix anything it misread. Your changed pages are attached as images too.
						</p>
						<textarea
							value={answer.text}
							onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
							disabled={answer.busy !== null}
							placeholder={answer.busy === "transcribing" ? "Reading your handwriting…" : "Your answer"}
							className="mt-3 h-56 w-full resize-none rounded-md border border-border bg-background p-3 font-prose text-[15px] select-text"
						/>
						{answer.error && <p role="alert" className="mt-2 text-xs text-red-400">{answer.error}</p>}
						<div className="mt-3 flex items-center gap-2">
							<button type="button" onClick={() => void transcribe()} disabled={answer.busy !== null} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">
								{answer.busy === "transcribing" ? "Transcribing…" : "Transcribe again"}
							</button>
							<span className="flex-1" />
							<button type="button" onClick={() => setAnswer(null)} disabled={answer.busy === "sending"} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground">
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void send()}
								disabled={answer.busy !== null || !answer.text.trim()}
								className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
							>
								{answer.busy === "sending" ? "Sending…" : "Send answer"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function blankPage(): Page {
	return { id: newPageId(), kind: "ink", version: 0, sentVersion: 0, hasContent: false, ext: "png", strokes: [], dirty: false };
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex h-full min-h-60 flex-col items-center justify-center p-6 text-center">{children}</div>;
}

function ToolButton({
	label, active, disabled, onClick, children,
}: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={active}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={`flex h-9 min-w-9 items-center justify-center rounded-md px-2 disabled:opacity-40 ${active ? "bg-accent ring-1 ring-foreground/40" : "hover:bg-accent/60"}`}
		>
			{children}
		</button>
	);
}

/** The writing surface: committed strokes on one canvas, the live stroke on
 *  an overlay. Pencil (and mouse) draw; fingers scroll unless finger drawing
 *  is on. */
function InkSurface({
	strokes, tool, color, width, fingerDraws, onChange,
}: {
	strokes: Stroke[];
	tool: InkTool | "eraser";
	color: string;
	width: number;
	fingerDraws: boolean;
	onChange: (strokes: Stroke[], recordUndo: boolean) => void;
}) {
	const wrap = useRef<HTMLDivElement>(null);
	const base = useRef<HTMLCanvasElement>(null);
	const live = useRef<HTMLCanvasElement>(null);
	const active = useRef<{ pointerId: number; stroke: Stroke | null } | null>(null);
	const strokesRef = useRef(strokes);
	const frame = useRef(0);
	const [size, setSize] = useState({ css: 0, dpr: 1 });

	useEffect(() => { strokesRef.current = strokes; }, [strokes]);

	// Backing-store size follows the CSS width × devicePixelRatio.
	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setSize({ css: el.clientWidth, dpr: Math.min(window.devicePixelRatio || 1, 2) }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const scale = size.css > 0 ? (size.css * size.dpr) / PAGE_WIDTH : 0;

	const prepare = useCallback((canvas: HTMLCanvasElement | null) => {
		if (!canvas || scale === 0) return null;
		const w = Math.round(PAGE_WIDTH * scale);
		const h = Math.round(PAGE_HEIGHT * scale);
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
		const ctx = canvas.getContext("2d")!;
		ctx.setTransform(scale, 0, 0, scale, 0, 0);
		return ctx;
	}, [scale]);

	// Redraw committed strokes whenever they (or the size) change.
	useEffect(() => {
		const ctx = prepare(base.current);
		if (ctx) drawPage(ctx, strokes, "#ffffff");
		prepare(live.current);
	}, [strokes, prepare]);

	// Stop the Pencil from scrolling the page; fingers keep scrolling.
	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const block = (e: TouchEvent) => {
			const t = e.touches[0] as (Touch & { touchType?: string }) | undefined;
			if ((t && t.touchType === "stylus") || (fingerDraws && t)) e.preventDefault();
		};
		el.addEventListener("touchstart", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => { el.removeEventListener("touchstart", block); el.removeEventListener("touchmove", block); };
	}, [fingerDraws]);

	const toPage = (e: { clientX: number; clientY: number; pressure: number }): [number, number, number] => {
		const rect = live.current!.getBoundingClientRect();
		return [((e.clientX - rect.left) / rect.width) * PAGE_WIDTH, ((e.clientY - rect.top) / rect.height) * PAGE_HEIGHT, e.pressure];
	};

	const paintLive = () => {
		frame.current = 0;
		const ctx = prepare(live.current);
		if (!ctx) return;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
		const s = active.current?.stroke;
		if (s) drawStroke(ctx, s);
	};

	// Finger scrolling is done by hand: touch-action stays "none" so the
	// browser can never claim a Pencil stroke as a pan gesture.
	const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null);

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (e.pointerType === "touch" && !fingerDraws) {
			if (!pan.current && !active.current) pan.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
			return;
		}
		if (active.current) return; // one pointer at a time (palm rejection)
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		const pt = toPage(e);
		if (tool === "eraser") {
			active.current = { pointerId: e.pointerId, stroke: null };
			const kept = eraseAt(strokesRef.current, pt[0], pt[1], 18);
			onChange(kept, true);
			return;
		}
		active.current = { pointerId: e.pointerId, stroke: { tool, color, width, points: [pt] } };
		paintLive();
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const p = pan.current;
		if (p && p.pointerId === e.pointerId) {
			const scroller = wrap.current?.closest("main");
			if (scroller) scroller.scrollBy(p.x - e.clientX, p.y - e.clientY);
			pan.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
			return;
		}
		const a = active.current;
		if (!a || a.pointerId !== e.pointerId) return;
		const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
		if (!a.stroke) {
			let kept = strokesRef.current;
			for (const ev of events) { const pt = toPage(ev); kept = eraseAt(kept, pt[0], pt[1], 18); }
			if (kept !== strokesRef.current) { strokesRef.current = kept; onChange(kept, false); }
			return;
		}
		for (const ev of events) a.stroke.points.push(toPage(ev));
		if (!frame.current) frame.current = requestAnimationFrame(paintLive);
	};

	const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (pan.current?.pointerId === e.pointerId) { pan.current = null; return; }
		const a = active.current;
		if (!a || a.pointerId !== e.pointerId) return;
		active.current = null;
		if (a.stroke && a.stroke.points.length > 0) {
			// Paint it onto the committed layer now: no flash before React re-renders.
			const ctx = prepare(base.current);
			if (ctx) drawStroke(ctx, a.stroke);
			onChange([...strokesRef.current, a.stroke], true);
		}
		if (frame.current) cancelAnimationFrame(frame.current);
		paintLive();
	};

	return (
		<div ref={wrap} className="relative mx-auto w-full max-w-[1100px] shadow-lg" style={{ aspectRatio: `${PAGE_WIDTH} / ${PAGE_HEIGHT}` }}>
			<canvas ref={base} className="absolute inset-0 size-full rounded-sm" />
			<canvas
				ref={live}
				className="absolute inset-0 size-full"
				style={{ touchAction: "none" }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finish}
				onPointerCancel={finish}
			/>
		</div>
	);
}
