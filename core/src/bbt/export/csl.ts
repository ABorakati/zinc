// Better CSL JSON and Better CSL YAML: CSL-JSON whose `id` is the Better BibTeX citation key (also in `citation-key`).
import { itemToCsl } from "../../cite/csl";
import { stripCitationKeyLine } from "../text";
import type { BbtExportItem } from "./bibtex";

export function betterCslItems(items: BbtExportItem[], keys: string[]): Record<string, unknown>[] {
	return items.map((it, i) => {
		const data = { ...it.data };
		// the pin travels as the id; do not let an Extra `Citation Key:` line leak in as a stray variable
		if (typeof data.extra === "string") data.extra = stripCitationKeyLine(data.extra);
		const csl = itemToCsl(data as typeof it.data) as Record<string, unknown>;
		csl.id = keys[i]!;
		csl["citation-key"] = keys[i]!;
		if (it.tags.length) csl.keyword = it.tags.join(", ");
		return csl;
	});
}

export function exportBetterCslJson(items: BbtExportItem[], keys: string[]): string {
	return `${JSON.stringify(betterCslItems(items, keys), null, 2)}\n`;
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ ./()-]*$/;
function scalar(v: unknown): string {
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	const s = String(v);
	if (PLAIN.test(s) && !/^(true|false|null|yes|no|on|off|~|\d[\d.e+-]*)$/i.test(s) && !s.endsWith(" ") && !s.includes(": ")) return s;
	return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

function emit(v: unknown, indent: string, out: string[], _first: string): void {
	if (Array.isArray(v)) {
		if (!v.length) return;
		for (const el of v) {
			if (el !== null && typeof el === "object") {
				const lines: string[] = [];
				emit(el, `${indent}  `, lines, "");
				// merge the first line of the element after "- "
				const rest = lines.filter((l, i) => !(i === 0 && l === ""));
				out.push(`${indent}- ${rest[0]!.slice(indent.length + 2)}`);
				for (const l of rest.slice(1)) out.push(l);
			} else out.push(`${indent}- ${scalar(el)}`);
		}
		return;
	}
	if (v !== null && typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== null && x !== "");
		for (const [k, x] of entries) {
			if (x !== null && typeof x === "object") {
				if (Array.isArray(x) && !x.length) continue;
				out.push(`${indent}${scalarKey(k)}:`);
				emit(x, Array.isArray(x) ? indent : `${indent}  `, out, "");
			} else out.push(`${indent}${scalarKey(k)}: ${scalar(x)}`);
		}
	}
}
const scalarKey = (k: string) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k));

/** `---\nreferences:\n- id: ...\n...` as Better CSL YAML does. */
export function exportBetterCslYaml(items: BbtExportItem[], keys: string[]): string {
	const refs = betterCslItems(items, keys);
	const out: string[] = ["---", "references:"];
	for (const r of refs) {
		const lines: string[] = [];
		emit(r, "  ", lines, "");
		if (!lines.length) continue;
		out.push(`- ${lines[0]!.slice(2)}`);
		for (const l of lines.slice(1)) out.push(l.startsWith("  ") ? l.slice(0) : l);
	}
	out.push("...", "");
	return out.join("\n");
}
