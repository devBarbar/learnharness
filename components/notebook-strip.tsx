"use client";
/**
 * The notebook pages an answer carried (iPad companion): a row of small
 * previews under the answered card; a click opens the page full size.
 */

import { useState } from "react";
import { validNotebookAttachments, type NotebookAttachment } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";

function fileUrl(chatId: string, a: NotebookAttachment): string {
	return `/api/companion/file?chatId=${encodeURIComponent(chatId)}&file=${encodeURIComponent(a.file)}`;
}

export function NotebookStrip({
	chatId,
	notebook,
	noVision,
}: {
	chatId?: string;
	notebook: unknown;
	noVision?: boolean;
}) {
	const attachments = validNotebookAttachments(notebook);
	const [open, setOpen] = useState<NotebookAttachment | null>(null);
	if (!chatId || attachments.length === 0) return null;
	return (
		<div data-testid="notebook-strip" className="my-2 flex flex-col gap-1.5">
			<div className="flex flex-wrap gap-2">
				{attachments.map((a) => (
					<button
						key={a.file}
						type="button"
						onClick={() => setOpen(a)}
						title={`Notebook page ${a.pageNumber}${a.kind === "photo" ? " (photo)" : ""}`}
						className="overflow-hidden rounded-md border border-border bg-white transition-colors hover:border-muted-foreground/50"
					>
						{/* eslint-disable-next-line @next/next/no-img-element -- local API image, no optimizer */}
						<img src={fileUrl(chatId, a)} alt={`Notebook page ${a.pageNumber}`} className="h-20 w-auto max-w-40 object-contain" />
					</button>
				))}
			</div>
			<p className="text-xs text-muted-foreground/70">
				{noVision
					? "Notebook pages attached, but the current model can't read images, so they weren't sent."
					: `${attachments.length} notebook page${attachments.length === 1 ? "" : "s"} sent with this answer`}
			</p>
			{open && <PageViewer chatId={chatId} page={open} onClose={() => setOpen(null)} />}
		</div>
	);
}

function PageViewer({ chatId, page, onClose }: { chatId: string; page: NotebookAttachment; onClose: () => void }) {
	const dismiss = useBackdropDismiss(onClose);
	return (
		<div
			{...dismiss}
			role="dialog"
			aria-label={`Notebook page ${page.pageNumber}`}
			tabIndex={-1}
			onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		>
			{/* eslint-disable-next-line @next/next/no-img-element -- local API image, no optimizer */}
			<img
				src={fileUrl(chatId, page)}
				alt={`Notebook page ${page.pageNumber}`}
				className="max-h-[90vh] max-w-[90vw] rounded-md bg-white object-contain shadow-xl"
			/>
		</div>
	);
}
