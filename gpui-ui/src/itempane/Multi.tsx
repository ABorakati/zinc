// Multi-selection summary: "N items selected" with bulk editing capabilities:
// Add/remove tags, add/remove collections, set or clear fields, Find Full Text, move to Trash with confirmation.
import { createMemo, createSignal, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { Button, confirm, Select, toast } from "../ui";
import { findFullText } from "./actions";
import { BoxInput, Picker, TextBtn, t, tok, tx } from "./kit";
import { fail, refreshStore } from "./model";
import { ipApi } from "./net";
import { createTagSource } from "./Tags";
import { useFlatCollections } from "./Collections";
import type { FlatCollection } from "./util";

export const COMMON_FIELDS = [
	{ value: "publicationTitle", label: "Publication" },
	{ value: "date", label: "Date" },
	{ value: "publisher", label: "Publisher" },
	{ value: "place", label: "Place" },
	{ value: "volume", label: "Volume" },
	{ value: "issue", label: "Issue" },
	{ value: "pages", label: "Pages" },
	{ value: "series", label: "Series" },
	{ value: "language", label: "Language" },
	{ value: "DOI", label: "DOI" },
	{ value: "url", label: "URL" },
	{ value: "rights", label: "Rights" },
	{ value: "extra", label: "Extra" },
	{ value: "archive", label: "Archive" },
	{ value: "callNumber", label: "Call Number" },
	{ value: "libraryCatalog", label: "Library Catalog" },
];

interface ProgressState {
	current: number;
	total: number;
	label: string;
}

export function MultiSelect(p: { keys: () => string[] }): JSX.Element {
	const suggest = createTagSource();
	const flat = useFlatCollections();
	const [field, setField] = createSignal("publicationTitle");
	const [fieldVal, setFieldVal] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [progress, setProgress] = createSignal<ProgressState | null>(null);

	const inCollection = createMemo(() => store.view().kind === "collection");
	const currentColl = createMemo(() => {
		const v = store.view();
		if (v.kind !== "collection") return null;
		return store.collections().find((c) => c.key === v.key) ?? null;
	});

	async function runBatched<T>(
		items: T[],
		label: string,
		batchSize: number,
		worker: (item: T) => Promise<unknown>,
	): Promise<void> {
		const total = items.length;
		if (total > 5) setProgress({ current: 0, total, label });
		try {
			for (let i = 0; i < total; i += batchSize) {
				const chunk = items.slice(i, i + batchSize);
				await Promise.all(chunk.map(worker));
				if (total > 5) setProgress({ current: Math.min(i + chunk.length, total), total, label });
			}
		} finally {
			setProgress(null);
		}
	}

	async function addTag(raw: string) {
		const tag = raw.trim();
		if (!tag || busy()) return;
		const keys = p.keys();
		if (!keys.length) return;
		if (keys.length > 10) {
			const ok = await confirm({
				title: `Add tag "${tag}" to ${keys.length} items?`,
				body: "This will add the tag to every selected item.",
				confirmLabel: "Add Tag",
			});
			if (!ok) return;
		}
		setBusy(true);
		try {
			await runBatched(keys, "Adding tag…", 10, (k) => ipApi.addTags(k, [tag]));
			ipApi.invalidateTags();
			refreshStore();
			toast(`Added tag "${tag}" to ${keys.length} items`, { kind: "success" });
		} catch (e) {
			fail("Could not add tag", e);
		} finally {
			setBusy(false);
		}
	}

	async function removeTag(raw: string) {
		const tag = raw.trim();
		if (!tag || busy()) return;
		const keys = p.keys();
		if (!keys.length) return;
		if (keys.length > 10) {
			const ok = await confirm({
				title: `Remove tag "${tag}" from ${keys.length} items?`,
				body: "This will remove the tag from all selected items that have it.",
				confirmLabel: "Remove Tag",
			});
			if (!ok) return;
		}
		setBusy(true);
		try {
			await runBatched(keys, "Removing tag…", 10, (k) => ipApi.removeTags(k, [tag]));
			ipApi.invalidateTags();
			refreshStore();
			toast(`Removed tag "${tag}" from ${keys.length} items`, { kind: "success" });
		} catch (e) {
			fail("Could not remove tag", e);
		} finally {
			setBusy(false);
		}
	}

	async function addToCollection(c: FlatCollection) {
		if (busy()) return;
		const keys = p.keys();
		if (!keys.length) return;
		if (keys.length > 10) {
			const ok = await confirm({
				title: `Add ${keys.length} items to "${c.path[c.path.length - 1]}"?`,
				body: "This will link all selected items to this collection.",
				confirmLabel: "Add to Collection",
			});
			if (!ok) return;
		}
		setBusy(true);
		try {
			await ipApi.addToCollection(c.key, keys);
			refreshStore();
			toast(`Added ${keys.length} items to "${c.path[c.path.length - 1]}"`, { kind: "success" });
		} catch (e) {
			fail("Could not add to collection", e);
		} finally {
			setBusy(false);
		}
	}

	async function removeFromCurrentCollection() {
		const coll = currentColl();
		if (!coll || busy()) return;
		const keys = p.keys();
		if (!keys.length) return;
		if (keys.length > 10) {
			const ok = await confirm({
				title: `Remove ${keys.length} items from "${coll.name}"?`,
				body: "The items will remain in your library.",
				confirmLabel: "Remove",
			});
			if (!ok) return;
		}
		setBusy(true);
		try {
			await ipApi.removeFromCollection(coll.key, keys);
			refreshStore();
			toast(`Removed ${keys.length} items from "${coll.name}"`, { kind: "success" });
		} catch (e) {
			fail("Could not remove from collection", e);
		} finally {
			setBusy(false);
		}
	}

	async function applyField(fieldKey: string, value: string) {
		if (busy()) return;
		const keys = p.keys();
		if (!keys.length) return;
		const fieldDef = COMMON_FIELDS.find((f) => f.value === fieldKey);
		const fieldLabel = fieldDef ? fieldDef.label : fieldKey;
		const isClear = !value.trim();

		if (keys.length > 10) {
			const ok = await confirm({
				title: isClear ? `Clear ${fieldLabel} on ${keys.length} items?` : `Set ${fieldLabel} on ${keys.length} items?`,
				body: `This will ${isClear ? "clear" : "update"} "${fieldLabel}" on every selected item that has this field.`,
				confirmLabel: isClear ? "Clear Field" : "Set Field",
			});
			if (!ok) return;
		}

		setBusy(true);
		try {
			const schema = await ipApi.schema();
			const typeFields = new Map<string, Set<string>>();
			for (const it of schema.itemTypes) {
				typeFields.set(it.itemType, new Set(it.fields.map((f) => f.field)));
			}

			let count = 0;
			await runBatched(keys, isClear ? "Clearing field…" : "Setting field…", 5, async (k) => {
				const d = await ipApi.item(k);
				const itemType = d.data.itemType;
				const allowed = typeFields.get(itemType);
				if ((allowed && allowed.has(fieldKey)) || fieldKey in d.data) {
					await ipApi.patchItem(k, { [fieldKey]: isClear ? "" : value });
					count++;
				}
			});

			refreshStore();
			toast(isClear ? `Cleared "${fieldLabel}" on ${count} items` : `Set "${fieldLabel}" on ${count} items`, { kind: "success" });
		} catch (e) {
			fail(isClear ? "Could not clear field" : "Could not set field", e);
		} finally {
			setBusy(false);
		}
	}

	async function moveToTrash() {
		if (busy()) return;
		const keys = p.keys();
		if (!keys.length) return;
		const ok = await confirm({
			title: `Move ${keys.length} items to Trash?`,
			body: "Items in Trash can be restored or deleted permanently.",
			confirmLabel: "Move to Trash",
			danger: true,
		});
		if (!ok) return;

		setBusy(true);
		try {
			await runBatched(keys, "Moving to Trash…", 10, (k) => ipApi.setDeleted(k, true));
			store.setSelected(new Set());
			refreshStore();
			toast(`Moved ${keys.length} items to Trash`, { kind: "success" });
		} catch (e) {
			fail("Could not move to Trash", e);
		} finally {
			setBusy(false);
		}
	}

	const collections = (q: string) => {
		const needle = q.trim().toLowerCase();
		return flat().filter((c) => !needle || c.path.join(" ").toLowerCase().includes(needle)).slice(0, 50);
	};

	return (
		<div data-testid="ip-multi" style={{ ...t("flex flex-col items-center gap-3 px-4 pt-6 pb-6 w-full h-full"), overflowY: "auto" }}>
			<Icon name="files" size={36} strokeWidth={1.25} color={tok("muted-foreground")} style={{ opacity: 0.5 }} />
			<text style={{ ...tx("text-sm font-semibold") }}>{`${p.keys().length} items selected`}</text>

			<Show when={progress()}>
				<div style={{ ...t("flex flex-col gap-1 w-full p-2 rounded-md border border-border bg-muted/40"), maxWidth: 260 }}>
					<div style={{ ...t("flex items-center justify-between") }}>
						<text style={{ ...tx("text-xs font-medium") }}>{progress()!.label}</text>
						<text style={{ ...tx("text-xs text-muted-foreground") }}>{`${progress()!.current} / ${progress()!.total}`}</text>
					</div>
					<div style={{ width: "100%", height: 4, backgroundColor: tok("border"), borderRadius: 2, overflow: "hidden" }}>
						<div style={{ width: `${Math.round((progress()!.current / Math.max(progress()!.total, 1)) * 100)}%`, height: "100%", backgroundColor: tok("primary") }} />
					</div>
				</div>
			</Show>

			<div style={{ ...t("flex flex-col gap-3 w-full"), maxWidth: 260 }}>
				{/* Tags */}
				<div style={{ ...t("flex flex-col gap-1") }}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>Add tag to all</text>
					<Picker<string> placeholder="Tag name…" query={(q) => suggest(q)} label={(x) => x} icon={() => "tag"} onPick={(x) => void addTag(x)} onSubmitText={(x) => void addTag(x)} />
				</div>
				<div style={{ ...t("flex flex-col gap-1") }}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>Remove tag from all</text>
					<Picker<string> placeholder="Tag to remove…" query={(q) => suggest(q)} label={(x) => x} icon={() => "tag"} onPick={(x) => void removeTag(x)} onSubmitText={(x) => void removeTag(x)} />
				</div>

				{/* Collections */}
				<div style={{ ...t("flex flex-col gap-1") }}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>Add all to collection</text>
					<Picker<FlatCollection> placeholder="Choose collection…" listOnFocus query={collections} label={(c) => c.path.join(" › ")} icon={() => "folder"} onPick={(c) => void addToCollection(c)} />
				</div>
				<Show when={inCollection()}>
					<div style={{ ...t("flex flex-col gap-1") }}>
						<TextBtn icon="folder-minus" label={`Remove from "${currentColl()?.name || "collection"}"`} onClick={() => void removeFromCurrentCollection()} />
					</div>
				</Show>

				{/* Field set / clear */}
				<div style={{ ...t("flex flex-col gap-1.5") }}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>Set or clear field</text>
					<Select value={field()} options={COMMON_FIELDS} onChange={setField} />
					<BoxInput value={fieldVal()} placeholder="Value (or leave empty to clear)…" onInput={setFieldVal} onCommit={setFieldVal} />
					<div style={{ ...t("flex gap-2") }}>
						<TextBtn primary label="Set field" onClick={() => void applyField(field(), fieldVal())} />
						<TextBtn label="Clear field" onClick={() => void applyField(field(), "")} />
					</div>
				</div>

				{/* Bottom actions */}
				<div style={{ ...t("flex flex-col gap-2 pt-2 border-t border-border/60") }}>
					<div style={{ alignSelf: "flex-start" }}>
						<TextBtn icon="file-search" label="Find Full Text" onClick={() => void findFullText(p.keys())} />
					</div>
					<div style={{ alignSelf: "flex-start" }}>
						<Button variant="destructive" size="sm" onClick={() => void moveToTrash()}>
							<Icon name="trash-2" size={14} color="#fff" />
							<text style={{ ...tx("text-xs font-medium"), color: "#fff" }}>Move to Trash</text>
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
