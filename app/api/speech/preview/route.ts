/** POST /api/speech/preview — one sample sentence in the given voice
 *  (Settings → Read aloud → Listen). Body { voice, instructions }. */
import { speechPreview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return speechPreview(request);
}
