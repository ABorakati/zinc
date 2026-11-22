import { probeTrackingLocked } from "./tracking";
import { PREF_CHUNK_LEN, PREF_MAX_CHUNKS, PREF_PREFIX } from "./types";

/**
 * Read Zotero document preferences from custom document properties `ZOTERO_PREF_1`..`ZOTERO_PREF_199`, matching
 * `WordDoc.ReadPrefsXml` in C# so documents move unchanged between desktop Zotero, the COM add-in, and Office.js.
 */
export async function readPrefsXml(ctx: Word.RequestContext): Promise<string | null> {
	try {
		const props = ctx.document.properties.customProperties;
		props.load(["key", "value"]);
		await ctx.sync();
		const byKey = new Map<string, string>();
		for (const item of props.items ?? []) {
			if (item && typeof item.key === "string") {
				byKey.set(item.key, item.value == null ? "" : String(item.value));
			}
		}
		let out = "";
		for (let i = 1; i < PREF_MAX_CHUNKS; i++) {
			const v = byKey.get(PREF_PREFIX + i);
			if (v === undefined) break;
			out += v;
		}
		return out.length === 0 ? null : out;
	} catch {
		return null;
	}
}

/**
 * Store `xml` in 250-character chunks in custom document properties `ZOTERO_PREF_1..n`, deleting any previous chunks
 * first, exactly as `WordDoc.SetPrefs` does in C#.
 */
export async function writePrefsXml(ctx: Word.RequestContext, xml: string | null | undefined): Promise<void> {
	const props = ctx.document.properties.customProperties;
	props.load(["key", "value"]);
	await ctx.sync();

	let deletedAny = false;
	for (const item of props.items ?? []) {
		if (item && typeof item.key === "string" && /^ZOTERO_PREF_\d+$/.test(item.key)) {
			item.delete();
			deletedAny = true;
		}
	}
	if (deletedAny) await ctx.sync();

	const text = xml ?? "";
	if (!text) return;

	let n = 1;
	for (let i = 0; i < text.length && n < PREF_MAX_CHUNKS; i += PREF_CHUNK_LEN, n++) {
		props.add(PREF_PREFIX + n, text.slice(i, i + PREF_CHUNK_LEN));
	}
	await ctx.sync();
}

// ---------------------------------------------------------------- document identity, state, list, target

function basenameFromUrl(url: string): string {
	const clean = url.split(/[?#]/)[0]!.replace(/[/\\]+$/, "");
	const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
	const raw = idx >= 0 ? clean.slice(idx + 1) : clean;
	if (!raw) return "Document";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export interface DocIdentity {
	hasDoc: boolean;
	name: string;
	fullName: string;
	readOnly: boolean;
}

export function getDocIdentity(office: any, doc?: any): DocIdentity {
	// a Word.Document proxy throws PropertyNotLoaded for any property not loaded yet (isNullObject included): treat as absent
	const prop = (k: string): unknown => {
		try {
			return doc?.[k];
		} catch {
			return undefined;
		}
	};
	if (doc && prop("isNullObject") === true) return { hasDoc: false, name: "", fullName: "", readOnly: false };
	const officeDoc = office?.context?.document;
	if (officeDoc === null) return { hasDoc: false, name: "", fullName: "", readOnly: false };
	const docFullName = prop("fullName");
	const docName = prop("name");
	const docReadOnly = prop("readOnly");
	const rawUrl = typeof docFullName === "string" ? docFullName : typeof officeDoc?.url === "string" ? officeDoc.url : "";
	const explicitName = typeof docName === "string" && docName ? docName : "";
	const fullName = rawUrl || explicitName || "Document";
	const name = explicitName || (rawUrl ? basenameFromUrl(rawUrl) : "Document");
	const readOnlyMode = office?.DocumentMode?.ReadOnly ?? "readOnly";
	const readOnly =
		typeof docReadOnly === "boolean"
			? docReadOnly
			: officeDoc?.mode !== undefined && (officeDoc.mode === readOnlyMode || String(officeDoc.mode).toLowerCase() === "readonly");
	return { hasDoc: true, name, fullName, readOnly };
}

export async function readDocState(ctx: Word.RequestContext, office: any): Promise<Record<string, unknown>> {
	const id = getDocIdentity(office, ctx.document);
	if (!id.hasDoc) return { hasDoc: false };
	const prefsXml = await readPrefsXml(ctx);
	const trackingLocked = await probeTrackingLocked(ctx);
	return {
		hasDoc: true,
		name: id.name,
		fullName: id.fullName,
		readOnly: id.readOnly,
		prefsXml,
		protection: trackingLocked ? 0 : -1,
		trackingLocked,
	};
}

export async function listOpenDocs(ctx: Word.RequestContext, office: any): Promise<Record<string, unknown>[]> {
	const id = getDocIdentity(office, ctx.document);
	if (!id.hasDoc) return [];
	ctx.document.load("saved");
	await ctx.sync();
	const saved = typeof ctx.document.saved === "boolean" ? ctx.document.saved : true;
	return [{ name: id.name, path: id.fullName, active: true, saved, readOnly: id.readOnly }];
}

export function matchTargetDoc(office: any, doc: any, which: unknown): { target: string | null; result: Record<string, unknown> } {
	if (which === null || which === undefined || which === "") {
		return { target: null, result: { ok: true } };
	}
	const want = String(which);
	const id = getDocIdentity(office, doc);
	if (!id.hasDoc) throw new Error("No document is open in Word.");
	if (id.fullName.toLowerCase() === want.toLowerCase() || id.name.toLowerCase() === want.toLowerCase()) {
		return { target: id.fullName, result: { ok: true, name: id.name, path: id.fullName } };
	}
	throw new Error(`No open document matches '${want}'. Open documents: ${id.name}.`);
}
