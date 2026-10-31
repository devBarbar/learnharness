import { companionFile } from "@/src/server";

export async function GET(req: Request) {
	return companionFile(req);
}
