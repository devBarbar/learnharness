import { companionAdminStatus } from "@/src/server";

export async function GET() {
	return companionAdminStatus();
}
