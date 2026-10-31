import { companionAdminFocus } from "@/src/server";

export async function POST(req: Request) {
	return companionAdminFocus(req);
}
