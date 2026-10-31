import { companionDeletePage, companionReadPage, companionSavePage } from "@/src/server";

export async function GET(req: Request) {
	return companionReadPage(req);
}

export async function PUT(req: Request) {
	return companionSavePage(req);
}

export async function DELETE(req: Request) {
	return companionDeletePage(req);
}
