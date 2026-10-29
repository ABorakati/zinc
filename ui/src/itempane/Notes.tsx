import { createSignal, createEffect, on, For, Show, type Component } from "solid-js";
import { Pencil, Plus, StickyNote, Trash2, X } from "lucide-solid";
import { api } from "../api";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { ipApi } from "./api";
import { usePane } from "./ctx";
import { IconBtn, Section, TextBtn } from "./ui";

export const NotesSection: Component = () => {
	const { d, reload } = usePane();
	const notes = () => d.children.filter((c) => c.itemType === "note");
	const [openKey, setOpenKey] = createSignal<string | null>(null);
	const [adding, setAdding] = createSignal(false);
	createEffect(on(() => d.data.key, () => setOpenKey(null), { defer: true }));

	async function addNote() {
		if (adding()) return;
		setAdding(true);
		try {
			const r = await ipApi.createChild({ itemType: "note", parentItem: d.data.key, note: "<p></p>" });
			await reload();
			setOpenKey(r.data.key);
		} catch (e) {
			fail("Could not add note", e);
		} finally {
			setAdding(false);
		}
	}
	async function trash(key: string) {
		try {
			await api.setDeleted(key, true);
			if (openKey() === key) setOpenKey(null);
			await reload();
		} catch (e) {
			fail("Could not delete note", e);
		}
	}
	const close = () => { setOpenKey(null); void reload(); };

	return (
		<Section
			id="notes"
			title="Notes"
			icon={StickyNote}
			count={notes().length}
			actions={<IconBtn title="Add Note" onClick={addNote} disabled={adding()}><Plus /></IconBtn>}
		>
			<Show when={notes().length} fallback={
				<div class="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground">
					No notes <TextBtn onClick={addNote} disabled={adding()}><Plus /> Add Note</TextBtn>
				</div>
			}>
				<For each={notes()}>
					{(n) => (
						<div data-note={n.key}>
							<div
								class={cn("group/note flex items-center gap-1.5 rounded px-1.5 py-[3px] hover:bg-accent/60", openKey() === n.key && "bg-accent/60")}
								onClick={() => setOpenKey(openKey() === n.key ? null : n.key)}
							>
								<StickyNote class="size-4 flex-none text-amber-500" />
								<span class="min-w-0 flex-1 truncate">{n.title || "Untitled note"}</span>
								<div class="flex flex-none items-center gap-px opacity-0 transition-opacity group-focus-within/note:opacity-100 group-hover/note:opacity-100">
									<IconBtn title="Edit note" onClick={(e) => { e.stopPropagation(); setOpenKey(n.key); }}><Pencil /></IconBtn>
									<IconBtn title="Move note to Trash" onClick={(e) => { e.stopPropagation(); void trash(n.key); }}><Trash2 /></IconBtn>
								</div>
							</div>
							<Show when={openKey() === n.key}>
								<div class="mt-1 mb-1.5 overflow-hidden rounded-md border bg-background">
									<div class="flex h-6 items-center justify-between border-b bg-muted/50 px-2 text-[11px] text-muted-foreground">
										<span>Editing note</span>
										<button type="button" class="inline-flex items-center gap-0.5 rounded px-1 hover:bg-accent hover:text-foreground" onClick={close}>
											<X class="size-3" /> Close
										</button>
									</div>
									<iframe
										title="Note editor"
										src={`/note-host/index.html?note=${encodeURIComponent(n.key)}`}
										class="block h-[320px] w-full border-0 bg-background"
									/>
								</div>
							</Show>
						</div>
					)}
				</For>
			</Show>
		</Section>
	);
};
