// The features' view of the app store: ListStore (selection, view, refresh) is added to store.ts by the list owner, so it is
// read through a Partial cast and every use has a fallback; this file is the only place that knows.
import type { Collection, ListStore, View } from "../contracts";
import { store } from "../store";

const ls = () => store as unknown as Partial<ListStore>;

/** The selected top-level item keys (the multi-selection, else the focused item). */
export function selectedKeys(): string[] {
	const s = ls().selected?.();
	if (s && s.size) return [...s];
	const one = store.selectedItem();
	return one ? [one] : [];
}

/** Select exactly one item (or none) and focus it. */
export function selectOnly(key: string | null): void {
	ls().setSelected?.(new Set(key ? [key] : []));
	store.selectItem(key);
}

export function selectMany(keys: string[]): void {
	ls().setSelected?.(new Set(keys));
	store.selectItem(keys.length === 1 ? keys[0]! : null);
}

/** The library on screen (1 = My Library): tag maintenance acts on it. */
export function libraryId(): number {
	return store.libraryId();
}

/** Re-fetch collections and the item list after a change (imports, trash, merges…). */
export function refresh(): void {
	ls().refresh?.();
}

export function currentView(): View {
	const v = ls().view?.();
	if (v) return v;
	const c = store.selectedCollection();
	if (c === "unfiled") return { kind: "unfiled" };
	if (c === "trash") return { kind: "trash" };
	return c ? { kind: "collection", key: c } : { kind: "library" };
}

export function setView(v: View): void {
	if (ls().setView) ls().setView!(v);
	else store.selectCollection(v.kind === "collection" ? v.key : v.kind === "unfiled" || v.kind === "trash" ? v.kind : null);
}

/** The collection new items are filed into (the open collection, if any). */
export function currentCollection(): string | undefined {
	const v = currentView();
	return v.kind === "collection" ? v.key : undefined;
}

export function collectionName(key: string): string {
	const walk = (l: Collection[]): string | undefined => {
		for (const c of l) {
			if (c.key === key) return c.name;
			const r = c.children && walk(c.children);
			if (r) return r;
		}
	};
	return walk(store.collections()) ?? key;
}

/** All collections as "Parent / Child" labels in tree order. */
export function collectionOptions(): { key: string; label: string }[] {
	const out: { key: string; label: string }[] = [];
	const walk = (l: Collection[], prefix: string) => {
		for (const c of l) {
			out.push({ key: c.key, label: prefix + c.name });
			if (c.children) walk(c.children, prefix + c.name + " / ");
		}
	};
	walk(store.collections(), "");
	return out;
}
