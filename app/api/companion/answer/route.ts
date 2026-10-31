import { companionAnswer } from "@/src/server";

export async function POST(req: Request) {
	return companionAnswer(req);
}
