// Open an attachment's file in its default app. The core refuses program and script files (HTTP 409, see core/src/api.ts
// open-external and core/src/io/dangerous.ts) until the request says the user confirmed; this asks, then retries.
import { apiRequest } from "../api";
import { confirm } from "./dialogs";

export async function openAttachmentExternally(attachmentKey: string): Promise<void> {
	const path = `/attachments/${encodeURIComponent(attachmentKey)}/open-external`;
	try {
		await apiRequest("POST", path, {});
	} catch (e) {
		if ((e as { status?: number }).status !== 409) throw e;
		const ok = await confirm({
			title: "Open a program file?",
			body: `${(e as Error).message}\n\nThis file can run code on your computer. Open it only if you trust where it came from.`,
			confirmLabel: "Open anyway",
			danger: true,
		});
		if (ok) await apiRequest("POST", path, { confirm: true });
	}
}
