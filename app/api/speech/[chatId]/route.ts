/** GET /api/speech/[chatId] — the speech keys with complete stored audio
 *  in this session ("listen again"). */
import { speechList } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ chatId: string }> }) {
	const { chatId } = await ctx.params;
	return speechList(chatId);
}
