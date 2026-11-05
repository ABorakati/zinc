// Routes under /api/bbt/ (contract: ./types.ts). Returns null for other paths.
import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { addAutoExport, listAutoExports, removeAutoExport, runAutoExport } from "./autoexport";
import { quickCopyText } from "./cite";
import { checkFormula, getKeyInfos, pinKey, previewFormula, refreshKeys, staleKeyCount, unpinKey } from "./keys";
import { getSettings, setSettings } from "./settings";
import { validPostfix } from "./formula";
import type { BbtSettings } from "./types";

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function readBody(req: Request): Promise<Record<string, any>> {
	let b: unknown;
	try {
		b = await req.json();
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
	if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be an object");
	return b as Record<string, any>;
}

const str = (v: unknown, name: string): string => {
	if (typeof v !== "string" || !v) throw new HttpError(400, `${name} is required`);
	return v;
};

export async function handleBbtApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/bbt/")) return null;
	const route = url.pathname.slice("/api/bbt/".length).replace(/\/+$/, "");
	try {
		if (route === "settings") {
			if (req.method === "GET") return json(getSettings(db));
			if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") throw new HttpError(405, "method not allowed");
			const b = await readBody(req);
			const patch = (b.patch ?? b) as Partial<BbtSettings>;
			if (typeof patch.citekeyFormat === "string") {
				const bad = checkFormula(patch.citekeyFormat);
				if (bad) throw new HttpError(400, `invalid formula: ${bad.error}`);
			}
			if (typeof patch.postfix === "string" && !validPostfix(patch.postfix)) throw new HttpError(400, "postfix must contain exactly one of %(a)s, %(A)s or %(n)s");
			try {
				const settings = setSettings(db, patch);
				return json({ settings, staleKeys: staleKeyCount(db), formulaError: null });
			} catch (e) {
				throw new HttpError(400, e instanceof Error ? e.message : String(e));
			}
		}
		if (route === "formula" && req.method === "POST") {
			const b = await readBody(req);
			if (typeof b.formula !== "string") throw new HttpError(400, "formula is required");
			return json(previewFormula(db, b.formula, typeof b.itemKey === "string" ? b.itemKey : undefined));
		}
		if (route === "keys" && req.method === "GET") {
			const items = (url.searchParams.get("items") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			if (items.length > 5000) throw new HttpError(400, "too many items");
			return json({ keys: getKeyInfos(db, items) });
		}
		if (route === "pin" && req.method === "POST") {
			const b = await readBody(req);
			return json(pinKey(db, str(b.itemKey, "itemKey"), typeof b.key === "string" && b.key ? b.key : undefined));
		}
		if (route === "unpin" && req.method === "POST") {
			const b = await readBody(req);
			return json(unpinKey(db, str(b.itemKey, "itemKey")));
		}
		if (route === "refresh" && req.method === "POST") {
			const b = await readBody(req);
			if (b.items !== undefined && (!Array.isArray(b.items) || b.items.some((x: unknown) => typeof x !== "string"))) throw new HttpError(400, "items must be an array of strings");
			return json({ updated: refreshKeys(db, b.items) });
		}
		if (route === "cite" && req.method === "POST") {
			const b = await readBody(req);
			if (!Array.isArray(b.items) || b.items.some((x: unknown) => typeof x !== "string")) throw new HttpError(400, "items must be an array of strings");
			const s = getSettings(db);
			const format = typeof b.format === "string" && b.format ? b.format : s.quickCopy;
			const command = typeof b.command === "string" && b.command ? b.command : s.citeCommand;
			return json({ text: quickCopyText(db, b.items, format, command) });
		}
		if (route === "autoexports") {
			if (req.method === "GET") return json({ exports: listAutoExports(db) });
			if (req.method === "POST") {
				const b = await readBody(req);
				return json(addAutoExport(db, { path: str(b.path, "path"), format: str(b.format, "format"), scope: b.scope ?? { type: "library" }, trigger: b.trigger, options: b.options }));
			}
			throw new HttpError(405, "method not allowed");
		}
		if (route === "autoexports/remove" && req.method === "POST") {
			const b = await readBody(req);
			return json({ removed: removeAutoExport(db, Number(b.id)) });
		}
		if (route === "autoexports/run" && req.method === "POST") {
			const b = await readBody(req);
			return json(runAutoExport(db, Number(b.id)));
		}
		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
