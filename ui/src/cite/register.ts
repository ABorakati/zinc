// Registers this feature's menu entries, dialogs and sidebar sections (see lib/registry.ts).
// Citations and bibliographies: Quick Copy (Ctrl+Shift+C / Ctrl+Shift+A), Create Bibliography dialogs, style settings.
import { createComponent } from "solid-js";
import { BookMarked, ClipboardCopy, Quote, Settings2 } from "lucide-solid";
import { toast } from "solid-sonner";
import { api } from "~/api";
import { fail } from "~/lib/actions";
import { registerAppAction, registerCollectionAction, registerItemAction, registerOverlay } from "~/lib/registry";
import { store } from "~/store";
import { citeApi, copyRich, type CiteMode } from "./client";
import { CiteDialogs, openBibliography, openCiteSettings } from "./dialogs";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Quick Copy: format the items in the Quick Copy style and put HTML + plain text on the clipboard. */
async function quickCopy(keys: string[], mode: CiteMode) {
	if (keys.length === 0) return;
	try {
		const s = (await citeApi.settings()).quickCopy;
		const r = await citeApi.format({ keys, style: s.style, locale: s.locale, mode, format: ["html", "text"] });
		await copyRich(r.html ?? "", r.text ?? "");
		toast.success(`${mode === "citation" ? "Citation" : "Bibliography"} copied (${plural(r.keys.length, "item")}, ${s.style})`);
	} catch (e) {
		fail(mode === "citation" ? "Could not copy the citation" : "Could not copy the bibliography", e);
	}
}

async function collectionKeys(collectionKey: string): Promise<string[]> {
	const keys: string[] = [];
	const q = { collection: collectionKey, sort: "creator", dir: "asc" as const };
	for (let offset = 0; ; offset += 1000) {
		const page = await api.items(q, offset, 1000);
		keys.push(...page.items.map((i) => i.key));
		if (keys.length >= page.total || page.items.length === 0) break;
	}
	return keys;
}

registerItemAction({
	id: "cite.copy-bibliography",
	label: "Copy Bibliography",
	icon: ClipboardCopy,
	group: "cite",
	shortcut: "Ctrl+Shift+C",
	run: (ctx) => void quickCopy(ctx.keys, "bibliography"),
});
registerItemAction({
	id: "cite.copy-citation",
	label: "Copy Citation",
	icon: Quote,
	group: "cite",
	shortcut: "Ctrl+Shift+A",
	run: (ctx) => void quickCopy(ctx.keys, "citation"),
});
registerItemAction({
	id: "cite.create-bibliography",
	label: "Create Bibliography from Items…",
	icon: BookMarked,
	group: "cite",
	run: (ctx) => void openBibliography(plural(ctx.keys.length, "selected item"), ctx.keys),
});

registerCollectionAction({
	id: "cite.create-bibliography-collection",
	label: "Create Bibliography from Collection…",
	icon: BookMarked,
	run: (ctx) => void openBibliography(`Collection "${ctx.name}"`, () => collectionKeys(ctx.collectionKey)),
});

registerAppAction({
	id: "cite.settings",
	label: "Citation Style Settings…",
	icon: Settings2,
	menu: "tools",
	run: openCiteSettings,
});

registerOverlay("cite", () => createComponent(CiteDialogs, {}));

// Keyboard shortcuts, acting on the selected items (ignored while typing in a field or when a dialog is open).
const isEditable = (t: EventTarget | null) => {
	const el = t as HTMLElement | null;
	return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};
if (typeof window !== "undefined") {
	window.addEventListener("keydown", (e) => {
		if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k !== "c" && k !== "a") return;
		if (isEditable(e.target) || document.querySelector("[role=dialog]")) return;
		const keys = [...store.selected()];
		if (keys.length === 0) return;
		e.preventDefault();
		void quickCopy(keys, k === "c" ? "bibliography" : "citation");
	});
}
