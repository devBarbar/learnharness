import { companionTranscribe } from "@/src/server";

export async function POST(req: Request) {
	return companionTranscribe(req);
}
