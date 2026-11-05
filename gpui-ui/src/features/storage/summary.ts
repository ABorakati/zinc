// Pure helpers of the attachment-storage feature (ZotMoov): what the core's reports become in toasts, labels and the allowed-types field.
// No UI imports, so the tests can load it.
import { baseName, plural } from "../text";

export interface OrganizeReport {
	moved: number;
	copied: number;
	failed: { key: string; from: string; error: string }[];
	leftBehind: { key: string; path: string; error?: string }[];
	onlineOnly: number;
	locked: number;
	/** Count of skipped files. */
	skipped: number;
	skippedSample: { key: string; path: string; reason: string }[];
	bytes: number;
}

export type OrganizeAction = "move" | "copy" | "to-stored";

export interface Summary {
	kind: "success" | "info" | "error";
	title: string;
	description?: string;
}

/** The toast for a finished move / copy / convert. */
export function describeOrganize(r: OrganizeReport, action: OrganizeAction): Summary {
	const done = action === "copy" ? r.copied : r.moved;
	const verb = action === "copy" ? "copied" : action === "to-stored" ? "converted to stored files" : "moved";
	const notes: string[] = [];
	if (r.failed.length) notes.push(`${plural(r.failed.length, "file")} failed and ${r.failed.length === 1 ? "was" : "were"} left where ${r.failed.length === 1 ? "it was" : "they were"}: ${r.failed[0]!.error}`);
	if (r.locked) notes.push(`${plural(r.locked, "file")} open in another program skipped`);
	if (r.onlineOnly) notes.push(`${plural(r.onlineOnly, "online-only OneDrive file")} skipped`);
	if (r.leftBehind.length) notes.push(`${plural(r.leftBehind.length, "original")} could not be deleted after copying`);
	const other = r.skipped - r.locked - r.onlineOnly;
	if (other > 0 && r.skippedSample.length) {
		const first = r.skippedSample.find((s) => !/open in another program|online-only/.test(s.reason));
		if (first) notes.push(`${plural(other, "file")} skipped: ${first.reason}`);
	}
	if (!done && !r.failed.length) return { kind: "info", title: "Nothing to do", description: notes.join(". ") || "Every file is already in place." };
	return { kind: r.failed.length ? "error" : "success", title: `${plural(done, "file")} ${verb}`, description: notes.join(". ") || undefined };
}

/** Menu label of "Attach newest file": names the folder it looks in. */
export const attachNewestLabel = (dir: string | null | undefined): string => (dir ? `Attach Newest File from ${baseName(dir)}` : "Attach Newest File…");

/** "pdf, epub" or ".PDF *.epub;docx" to a clean list (the core validates again). */
export function parseExtensions(text: string): string[] {
	return text.split(/[\s,;]+/).map((e) => e.trim().replace(/^\*?\./, "").toLowerCase()).filter((e, i, l) => e && l.indexOf(e) === i);
}

export const formatExtensions = (list: string[]): string => list.join(", ");
