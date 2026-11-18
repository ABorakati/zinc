// Text resolution (`ui-text`) and bundled assets. A plugin's Fluent bundle is resolved by a localizer the lifecycle/pkg area registers
// (`setLocalizer`); without one, a `localized` text shows its `fallback`, else its id (the WIT says the id is shown and a warning logged).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { L10nRef, UiText } from "./types";

export type Localizer = (pluginId: string, id: string, args: Record<string, string | number | bigint>) => string | undefined;
let localizer: Localizer | undefined;

/** The package area's Fluent service (plugin-host/src/package), looked up lazily so this module has no hard dependency on it. */
const packageLocalizer = (pluginId: string, ref: L10nRef): string | undefined => {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const svc = require("../../../../plugin-host/src/package/services").getServices();
		return svc.l10n.resolve(pluginId, { tag: "localized", val: ref }) as string | undefined;
	} catch {
		return undefined;
	}
};
/** Register the function that resolves a plugin's Fluent message (id may be "message.attribute"). */
export function setLocalizer(fn: Localizer | undefined): void {
	localizer = fn;
}

export function textOf(t: UiText | undefined, pluginId: string): string {
	if (!t) return "";
	if (t.tag === "plain") return t.val;
	const r = t.val;
	const args: Record<string, string | number | bigint> = {};
	for (const a of r.args) args[a.name] = a.value.val as string | number | bigint;
	let s: string | undefined;
	try {
		s = localizer ? localizer(pluginId, r.id, args) : packageLocalizer(pluginId, r);
	} catch {
		s = undefined;
	}
	return s ?? r.fallback ?? r.id;
}

// ---- bundled files (icons, images, html pages) ----

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	svg: "image/svg+xml",
	html: "text/html;charset=utf-8",
	htm: "text/html;charset=utf-8",
};
export const mimeOf = (path: string): string => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Read a file from a plugin package, refusing paths that leave the folder. Undefined when it does not exist. */
export function readPackageFile(dir: string | undefined, path: string): Uint8Array | undefined {
	if (!dir) return undefined;
	const root = resolve(dir);
	const full = resolve(join(root, path));
	if (full !== root && !full.startsWith(root + sep)) return undefined;
	try {
		return existsSync(full) ? new Uint8Array(readFileSync(full)) : undefined;
	} catch {
		return undefined;
	}
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
	return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** An SVG as a data URL. */
export const svgUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** The `-dark` variant of a bundled path ("icons/a.svg" -> "icons/a-dark.svg"). */
export const darkVariant = (path: string) => path.replace(/(\.[a-z0-9]+)$/i, "-dark$1");
