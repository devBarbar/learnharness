/**
 * The companion notebook's ink model: vector strokes on a fixed logical
 * page, rendered with pressure-varying width. Pure geometry + canvas
 * drawing (no React), so the logic is unit-tested directly.
 */

/** Logical page size (portrait, roughly iPad proportions). */
export const PAGE_WIDTH = 1600;
export const PAGE_HEIGHT = 2200;

export type InkTool = "pen" | "highlighter";

export interface Stroke {
	tool: InkTool;
	color: string;
	/** Base width in logical px. */
	width: number;
	/** [x, y, pressure 0..1] in logical page coordinates. */
	points: Array<[number, number, number]>;
}

export interface InkPage {
	strokes: Stroke[];
}

export function serializeStrokes(strokes: readonly Stroke[]): string {
	// Round to 0.1 px / 0.01 pressure: an order of magnitude smaller JSON.
	return JSON.stringify({
		v: 1,
		strokes: strokes.map((s) => ({
			...s,
			points: s.points.map(([x, y, p]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100]),
		})),
	});
}

export function parseStrokes(json: string | null | undefined): Stroke[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json) as { strokes?: unknown };
		if (!Array.isArray(parsed.strokes)) return [];
		return parsed.strokes.filter((s): s is Stroke =>
			typeof s === "object" && s !== null &&
			((s as Stroke).tool === "pen" || (s as Stroke).tool === "highlighter") &&
			typeof (s as Stroke).color === "string" &&
			typeof (s as Stroke).width === "number" &&
			Array.isArray((s as Stroke).points),
		);
	} catch {
		return [];
	}
}

/** Width at a point: pressure thins/thickens the pen; highlighters stay flat. */
export function widthAt(stroke: Stroke, pressure: number): number {
	if (stroke.tool === "highlighter") return stroke.width;
	const p = pressure > 0 ? pressure : 0.5; // mice/fingers report 0 or 0.5
	return stroke.width * (0.35 + p * 1.1);
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does the eraser circle touch the stroke? */
export function strokeHit(stroke: Stroke, x: number, y: number, radius: number): boolean {
	const pts = stroke.points;
	const reach = radius + stroke.width;
	if (pts.length === 1) return Math.hypot(pts[0]![0] - x, pts[0]![1] - y) <= reach;
	for (let i = 1; i < pts.length; i++) {
		if (distanceToSegment(x, y, pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]) <= reach) return true;
	}
	return false;
}

/** Stroke eraser: whole strokes the circle touches are removed. */
export function eraseAt(strokes: readonly Stroke[], x: number, y: number, radius: number): Stroke[] {
	const kept = strokes.filter((s) => !strokeHit(s, x, y, radius));
	return kept.length === strokes.length ? (strokes as Stroke[]) : kept;
}

/** The lowest inked y — snapshots crop the blank page bottom away. */
export function contentBottom(strokes: readonly Stroke[]): number {
	let bottom = 0;
	for (const s of strokes) for (const [, y] of s.points) bottom = Math.max(bottom, y + s.width * 2);
	return bottom;
}

/** Snapshot height: content plus a margin, at least a third of a page. */
export function snapshotHeight(strokes: readonly Stroke[]): number {
	return Math.min(PAGE_HEIGHT, Math.max(Math.round(PAGE_HEIGHT / 3), Math.ceil(contentBottom(strokes) + 80)));
}

/** Draw one stroke (logical coordinates; the caller scales the context). */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
	const pts = stroke.points;
	if (pts.length === 0) return;
	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.strokeStyle = stroke.color;
	ctx.fillStyle = stroke.color;
	if (stroke.tool === "highlighter") {
		ctx.globalAlpha = 0.35;
		ctx.lineWidth = stroke.width;
		ctx.beginPath();
		ctx.moveTo(pts[0]![0], pts[0]![1]);
		for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
		ctx.stroke();
		ctx.restore();
		return;
	}
	if (pts.length === 1) {
		ctx.beginPath();
		ctx.arc(pts[0]![0], pts[0]![1], widthAt(stroke, pts[0]![2]) / 2, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
		return;
	}
	// Segment-by-segment quadratic midpoints: width follows pressure.
	for (let i = 1; i < pts.length; i++) {
		const [x0, y0] = i === 1 ? pts[0]! : [(pts[i - 2]![0] + pts[i - 1]![0]) / 2, (pts[i - 2]![1] + pts[i - 1]![1]) / 2];
		const [cx, cy, cp] = pts[i - 1]!;
		const [x1, y1] = [(pts[i - 1]![0] + pts[i]![0]) / 2, (pts[i - 1]![1] + pts[i]![1]) / 2];
		ctx.lineWidth = widthAt(stroke, (cp + pts[i]![2]) / 2);
		ctx.beginPath();
		ctx.moveTo(x0, y0);
		ctx.quadraticCurveTo(cx, cy, i === pts.length - 1 ? pts[i]![0] : x1, i === pts.length - 1 ? pts[i]![1] : y1);
		ctx.stroke();
	}
	ctx.restore();
}

export function drawPage(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], background: string | null): void {
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.restore();
	if (background) {
		ctx.save();
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
		ctx.restore();
	}
	for (const s of strokes) drawStroke(ctx, s);
}

/** The page as a white-background PNG data URL (what the model sees). */
export function exportPagePng(strokes: readonly Stroke[], doc: Document = document): string {
	const height = snapshotHeight(strokes);
	const canvas = doc.createElement("canvas");
	canvas.width = PAGE_WIDTH;
	canvas.height = height;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, PAGE_WIDTH, height);
	for (const s of strokes) drawStroke(ctx, s);
	return canvas.toDataURL("image/png");
}

/** Downscale a photo to at most `max` px on its long side, as JPEG. */
export async function photoToJpeg(file: Blob, max = 2000, doc: Document = document): Promise<string> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
	const canvas = doc.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	return canvas.toDataURL("image/jpeg", 0.85);
}

export function newPageId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return `pg_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}
