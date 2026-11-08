/** GET /api/speech/[chatId]/[key]/[file] — one stored MP3 piece. */
import { speechPiece } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ chatId: string; key: string; file: string }> }) {
	const { chatId, key, file } = await ctx.params;
	return speechPiece(chatId, key, file);
}
