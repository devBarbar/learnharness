import { companionAdminEnable } from "@/src/server";

export async function POST() {
	return companionAdminEnable();
}
