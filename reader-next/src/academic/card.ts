// Reference card (vanilla DOM port of ui/src/references/ReferenceCard.tsx content + reader actions).
import type { AcademicApi, Reference, ReferenceDetail } from "./api";
import { doiUrl, extractDoi, referenceUrl } from "../../../ui/src/references/match";
import { button, h } from "./dom";

export interface CardOpts {
	ref: Reference | null;
	/** text of the bibliography entry as printed in this PDF (shown when there is no API match) */
	rawText?: string;
	onJump?: () => void; // "Jump to reference in this PDF"
	onShowInRefs?: (index: number) => void;
	compact?: boolean; // list rows: no abstract fetch until asked
	onChange?: () => void;
}

export function buildRefCard(api: AcademicApi, o: CardOpts): HTMLElement {
	const root = h("div", { "data-testid": "rn-card" });
	let detail: ReferenceDetail | null = null;
	let loading = false;
	let failed: string | null = null;
	let busy: "add" | "ft" | null = null;
	let addError: string | null = null;

	const base = (): Reference | null => o.ref;
	const merged = (): Reference & Partial<ReferenceDetail> => ({ index: 0, ...(base() ?? {}), ...(detail ?? {}), inLibraryKey: base()?.inLibraryKey ?? detail?.inLibraryKey });

	async function load() {
		const r = base();
		if (!r || (!r.doi && !r.title)) return;
		loading = true;
		render();
		try { detail = await api.lookup(r); }
		catch (e) { failed = (e as Error).message; }
		loading = false;
		render();
	}

	async function add(thenFullText: boolean) {
		const r = base();
		const doi = r?.doi ?? extractDoi(o.rawText);
		busy = thenFullText ? "ft" : "add";
		addError = null;
		render();
		try {
			const key = await api.add({ doi, reference: r ?? undefined });
			if (r) r.inLibraryKey = key;
			else if (detail) detail.inLibraryKey = key;
			api.post({ type: "reference-added", key, index: r?.index });
			if (thenFullText) api.post({ type: "find-fulltext", keys: [key] });
			o.onChange?.();
		}
		catch (e) { addError = `Could not add: ${(e as Error).message}`; }
		busy = null;
		render();
	}

	function render() {
		const d = merged();
		const r = base();
		const doi = d.doi ?? extractDoi(o.rawText);
		const url = (r || doi) ? referenceUrl({ ...d, doi }) : undefined;
		const meta = [d.authors?.slice(0, 6).join(", ") + (d.authors && d.authors.length > 6 ? " et al." : ""), d.year, d.venue].filter((x) => x && x !== "undefined").join(" · ");
		root.textContent = "";
		root.append(
			h("div", { class: "rn-title" }, d.title ?? d.raw ?? o.rawText ?? "Reference", d.inLibraryKey ? h("span", { class: "rn-badge" }, "In library") : null),
			meta ? h("div", { class: "rn-meta" }, meta) : "",
		);
		if (!r && o.rawText) root.append(h("div", { class: "rn-raw", "data-testid": "rn-raw" }, o.rawText), h("div", { class: "rn-note" }, "No match in the resolved bibliography."));
		if (loading) root.append(h("div", { class: "rn-skel" }), h("div", { class: "rn-skel", style: { width: "80%" } }));
		else if (detail?.abstract) root.append(h("div", { class: "rn-abs", "data-testid": "rn-abstract" }, detail.abstract));
		else if (r && !failed && !o.compact) root.append(h("div", { class: "rn-note" }, "No abstract available."));
		else if (failed) root.append(h("div", { class: "rn-note" }, `Details unavailable (${failed}).`));

		const stats: string[] = [];
		if (d.citedByCount != null) stats.push(`Cited by ${d.citedByCount}`);
		if (d.referenceCount != null) stats.push(`${d.referenceCount} references`);
		if (d.type) stats.push(d.type);
		if (stats.length) root.append(h("div", { class: "rn-meta" }, stats.join(" · ")));

		const row = h("div", { class: "rn-row" });
		if (d.inLibraryKey) {
			row.append(
				button("Open in library", () => api.post({ type: "open-item", key: d.inLibraryKey }), { primary: true }),
				button("Find Full Text", () => api.post({ type: "find-fulltext", keys: [d.inLibraryKey] })),
			);
		}
		else if (r || doi) {
			row.append(
				button(busy === "add" ? "Adding…" : "Add to library", () => add(false), { primary: true }),
				button(busy === "ft" ? "Adding…" : "Add + Find Full Text", () => add(true)),
			);
			for (const b of row.querySelectorAll("button")) (b as HTMLButtonElement).disabled = !!busy;
		}
		if (url) row.append(button("Open in browser", () => api.openUrl(url).catch(() => {}), { title: url }));
		if (d.openAccessUrl) row.append(button("Open PDF", () => api.openUrl(d.openAccessUrl!).catch(() => {})));
		if (r) row.append(button("Show in References", () => { api.post({ type: "show-references", index: r.index }); o.onShowInRefs?.(r.index); }));
		if (o.onJump) row.append(button("Jump to reference in this PDF", () => o.onJump!()));
		if (row.childElementCount) root.append(row);
		if (addError) root.append(h("div", { class: "rn-note" }, addError));
	}

	render();
	void load();
	return root;
}

export { doiUrl };
