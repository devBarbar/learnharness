import { companionState } from "@/src/server";

export async function GET(req: Request) {
	return companionState(req);
}
