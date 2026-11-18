// `shell` (lifecycle.wit): open a URL, open a file, show a file in the file manager. `where: "zinc"`.
//
// A plugin never runs a command: a URL is validated here and handed to the OS opener as one argv element (data/os-hooks.ts), never
// through a shell.
//   http, https, mailto   need `shell.open-url`
//   other schemes         only those listed in the manifest's `permissions.shell.schemes`, and the user confirms the first use
//   file, javascript, data, vbscript, and anything with control characters or spaces: always refused
// Files: `shell.open-file` / `shell.reveal`; only the plugin's data, temp and granted files; programs and scripts are refused.
import { defineHandler, witError, type HandlerContext } from "./registry";
import { requirePermission } from "./data/perm";
import { getShellBackend } from "./data/os-hooks";
import { resolveRef, type PathRef } from "./data/fs-roots";
import { existsSync } from "node:fs";

const ALWAYS_REFUSED = new Set(["file", "javascript", "data", "vbscript", "blob", "about", "chrome", "view-source", "ms-msdt", "search-ms", "ms-officecmd"]);
const PLAIN = new Set(["http", "https", "mailto"]);
// programs and scripts (lifecycle.wit shell.open-file): refused by extension, whatever the platform
const EXECUTABLE = /\.(exe|bat|cmd|com|msi|msp|scr|pif|ps1|psm1|vbs|vbe|js|jse|jar|wsf|wsh|hta|cpl|reg|lnk|url|app|sh|bash|command|appimage|dll|scf|inf|gadget|msc|cmdline|desktop|workflow|action|apk)$/i;
const confirmedSchemes = new Set<string>();
const MAX_URL = 4096;

/** Validate a URL a plugin wants opened. Returns the normalised URL and its scheme. Pure: used by the tests. */
export function checkOpenUrl(input: string, allowedSchemes: readonly string[]): { url: string; scheme: string; custom: boolean } {
	if (typeof input !== "string" || !input || input.length > MAX_URL) throw witError("invalid-argument", "url is empty or too long");
	if (/[\u0000- \u007f]/.test(input)) throw witError("invalid-argument", "url has spaces or control characters");
	let u: URL;
	try {
		u = new URL(input);
	} catch {
		throw witError("invalid-argument", "invalid url");
	}
	const scheme = u.protocol.replace(/:$/, "").toLowerCase();
	if (ALWAYS_REFUSED.has(scheme)) throw witError("permission-denied", `${scheme}: URLs are never opened`);
	if (PLAIN.has(scheme)) {
		if ((scheme === "http" || scheme === "https") && (u.username || u.password)) throw witError("invalid-argument", "credentials in the URL are not allowed");
		return { url: u.href, scheme, custom: false };
	}
	if (!allowedSchemes.map((s) => s.toLowerCase()).includes(scheme)) throw witError("permission-denied", `scheme ${scheme}: is not in permissions.shell.schemes`);
	return { url: u.href, scheme, custom: true };
}

export function checkFileName(path: string): void {
	if (EXECUTABLE.test(path)) throw witError("permission-denied", "programs and scripts are never opened");
}

function allowedSchemes(ctx: HandlerContext): string[] {
	const s = (ctx.manifest.permissions as { shell?: { schemes?: string[] } } | undefined)?.shell?.schemes;
	return Array.isArray(s) ? s : [];
}

async function target(ctx: HandlerContext, ref: PathRef): Promise<string> {
	const r = resolveRef(ctx, ref, "read");
	if (r.root === "bundled") throw witError("permission-denied", "files of the plugin package are not opened");
	if (!existsSync(r.abs)) throw witError("not-found", ref.path || "target");
	return r.abs;
}

export default defineHandler({
	interface: "zinc:plugin/shell",
	where: "zinc",
	functions: {
		async "open-url"(ctx, url: string) {
			requirePermission(ctx, "shell.open-url");
			const v = checkOpenUrl(url, allowedSchemes(ctx));
			if (v.custom) {
				const key = `${ctx.pluginId}\u0000${v.scheme}`;
				if (!confirmedSchemes.has(key)) {
					if (!(await getShellBackend().confirmScheme(ctx.pluginId, v.scheme, v.url))) throw witError("permission-denied", `the user did not allow ${v.scheme}: links`);
					confirmedSchemes.add(key);
				}
			}
			try {
				await getShellBackend().openUrl(v.url);
			} catch (e) {
				throw witError("unavailable", (e as Error).message);
			}
		},

		async "open-file"(ctx, file: PathRef) {
			requirePermission(ctx, "shell.open-file");
			const abs = await target(ctx, file);
			checkFileName(abs);
			if (!(await Bun.file(abs).exists())) throw witError("invalid-argument", "only files can be opened");
			try {
				await getShellBackend().openFile(abs);
			} catch (e) {
				throw witError("unavailable", (e as Error).message);
			}
		},

		async reveal(ctx, file: PathRef) {
			requirePermission(ctx, "shell.reveal");
			const abs = await target(ctx, file);
			try {
				await getShellBackend().reveal(abs);
			} catch (e) {
				throw witError("unavailable", (e as Error).message);
			}
		},
	},
});
