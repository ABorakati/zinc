// `clipboard` (lifecycle.wit). `where: "zinc"`: the clipboard belongs to the Zinc process and its windows (focus, the first-read
// confirmation). Needs `clipboard.write` / `clipboard.read`. The backend is replaceable (data/os-hooks.ts `setClipboardBackend`).
import { defineHandler, witError } from "./registry";
import { requirePermission } from "./data/perm";
import { getClipboardBackend } from "./data/os-hooks";

const MAX_BYTES = 16 * 1024 * 1024;
const WRITES_PER_SECOND = 10;
const writes = new Map<string, number[]>();
const confirmed = new Set<string>(); // plugins whose first read this session was approved

export default defineHandler({
	interface: "zinc:plugin/clipboard",
	where: "zinc",
	functions: {
		async write(ctx, content: { text?: string; html?: string; imagePng?: Uint8Array }) {
			requirePermission(ctx, "clipboard.write");
			const size = (content.text?.length ?? 0) * 3 + (content.html?.length ?? 0) * 3 + (content.imagePng?.byteLength ?? 0);
			if (size > MAX_BYTES) throw witError("limit-exceeded", "clipboard content is limited to 16 MiB");
			const now = Date.now();
			const recent = (writes.get(ctx.pluginId) ?? []).filter((t) => now - t < 1000);
			if (recent.length >= WRITES_PER_SECOND) throw witError("limit-exceeded", `clipboard writes are limited to ${WRITES_PER_SECOND} a second`);
			recent.push(now);
			writes.set(ctx.pluginId, recent);
			try {
				await getClipboardBackend().write({ text: content.text ?? undefined, html: content.html ?? undefined, imagePng: content.imagePng ?? undefined });
			} catch (e) {
				throw witError("unavailable", (e as Error).message);
			}
		},

		async read(ctx) {
			requirePermission(ctx, "clipboard.read");
			const b = getClipboardBackend();
			if (!b.windowFocused()) throw witError("permission-denied", "clipboard.read needs a focused Zinc window");
			if (!confirmed.has(ctx.pluginId)) {
				if (!(await b.confirmRead(ctx.pluginId))) throw witError("permission-denied", "the user did not allow reading the clipboard");
				confirmed.add(ctx.pluginId);
			}
			try {
				const c = await b.read();
				return { text: c.text, html: c.html, imagePng: c.imagePng };
			} catch (e) {
				throw witError("unavailable", (e as Error).message);
			}
		},
	},
});
