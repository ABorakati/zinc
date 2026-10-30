import { createEffect, createMemo, createResource, createSignal, For, Show, type Component } from "solid-js";
import { api } from "~/api";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input, Textarea } from "~/components/ui/input";
import { itemTypeIcon, itemTypeLabel } from "~/lib/icons";
import { addByIdentifier, addLinkedFile, addLinkedUri, createNewItem, dialog, setDialog } from "./client";

const close = () => setDialog(null);

const IdentifierDialog: Component<{ initial: string }> = (p) => {
	const [text, setText] = createSignal(p.initial);
	const [busy, setBusy] = createSignal(false);
	let ta: HTMLTextAreaElement | undefined;
	createEffect(() => queueMicrotask(() => ta?.focus()));
	async function submit() {
		if (!text().trim() || busy()) return;
		setBusy(true);
		const r = await addByIdentifier(text());
		setBusy(false);
		if (r && !r.failed.length) close();
		else if (r) setText(r.failed.map((f) => f.id).join("\n")); // keep only what failed so it can be fixed and retried
	}
	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add Item by Identifier</DialogTitle>
					<DialogDescription>DOI, PMID, PMCID, arXiv ID or ISBN. Separate several with new lines or commas.</DialogDescription>
				</DialogHeader>
				<Textarea
					ref={ta}
					class="min-h-32 font-mono"
					placeholder={"10.1136/bmj-2023-078378\n31452104\narXiv:1706.03762\n978-0-13-468599-1"}
					value={text()}
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							void submit();
						}
					}}
				/>
				<DialogFooter class="gap-2">
					<Button variant="outline" size="sm" onClick={close}>Cancel</Button>
					<Button size="sm" disabled={busy() || !text().trim()} onClick={() => void submit()}>{busy() ? "Adding…" : "Add"}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const NewItemDialog: Component = () => {
	const [schema] = createResource(() => api.schema());
	const [q, setQ] = createSignal("");
	const [sel, setSel] = createSignal(0);
	const types = createMemo(() => {
		const s = q().trim().toLowerCase();
		return (schema()?.itemTypes ?? [])
			.filter((t) => !["attachment", "note", "annotation"].includes(t.itemType))
			.filter((t) => !s || t.label.toLowerCase().includes(s) || t.itemType.toLowerCase().includes(s));
	});
	createEffect(() => { types(); setSel(0); });
	function pick(t: string) {
		close();
		void createNewItem(t);
	}
	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent class="max-w-sm">
				<DialogHeader>
					<DialogTitle>New Item</DialogTitle>
					<DialogDescription>Choose an item type.</DialogDescription>
				</DialogHeader>
				<Input
					autofocus
					placeholder="Search item types…"
					value={q()}
					onInput={(e) => setQ(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, types().length - 1)); }
						else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
						else if (e.key === "Enter") { const t = types()[sel()]; if (t) pick(t.itemType); }
					}}
				/>
				<div class="max-h-72 overflow-y-auto" role="listbox">
					<For each={types()} fallback={<div class="px-2 py-3 text-xs text-muted-foreground">{schema.loading ? "Loading…" : "No matching item types"}</div>}>
						{(t, i) => {
							const Icon = itemTypeIcon(t.itemType);
							return (
								<button
									type="button"
									role="option"
									aria-selected={sel() === i()}
									class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-accent aria-selected:bg-accent"
									onMouseMove={() => setSel(i())}
									onClick={() => pick(t.itemType)}
								>
									<Icon class="size-4 text-muted-foreground" />
									{t.label || itemTypeLabel(t.itemType)}
								</button>
							);
						}}
					</For>
				</div>
			</DialogContent>
		</Dialog>
	);
};

const LinkFileDialog: Component<{ parentKey?: string }> = (p) => {
	const [path, setPath] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	async function submit() {
		if (!path().trim() || busy()) return;
		setBusy(true);
		const ok = await addLinkedFile(path(), p.parentKey);
		setBusy(false);
		if (ok) close();
	}
	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Link to File</DialogTitle>
					<DialogDescription>Full path of a file on this computer. The file stays where it is.</DialogDescription>
				</DialogHeader>
				<Input autofocus placeholder="C:\Users\you\Documents\paper.pdf" value={path()} onInput={(e) => setPath(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
				<DialogFooter class="gap-2">
					<Button variant="outline" size="sm" onClick={close}>Cancel</Button>
					<Button size="sm" disabled={busy() || !path().trim()} onClick={() => void submit()}>Link</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const LinkUriDialog: Component<{ parentKey?: string }> = (p) => {
	const [url, setUrl] = createSignal("");
	const [title, setTitle] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	async function submit() {
		if (!url().trim() || busy()) return;
		setBusy(true);
		const ok = await addLinkedUri(url(), title(), p.parentKey);
		setBusy(false);
		if (ok) close();
	}
	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Link to URI</DialogTitle>
					<DialogDescription>Web address or other URI to attach.</DialogDescription>
				</DialogHeader>
				<Input autofocus placeholder="https://…" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
				<Input placeholder="Title (optional)" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
				<DialogFooter class="gap-2">
					<Button variant="outline" size="sm" onClick={close}>Cancel</Button>
					<Button size="sm" disabled={busy() || !url().trim()} onClick={() => void submit()}>Add</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

/** One overlay hosting all add-items dialogs; each mounts fresh when opened. */
export const AddItemsDialogs: Component = () => {
	const d = dialog;
	return (
		<>
			<Show when={d()?.kind === "identifier"}>
				<IdentifierDialog initial={(d() as { text?: string }).text ?? ""} />
			</Show>
			<Show when={d()?.kind === "newItem"}>
				<NewItemDialog />
			</Show>
			<Show when={d()?.kind === "linkFile"}>
				<LinkFileDialog parentKey={(d() as { parentKey?: string }).parentKey} />
			</Show>
			<Show when={d()?.kind === "linkUri"}>
				<LinkUriDialog parentKey={(d() as { parentKey?: string }).parentKey} />
			</Show>
		</>
	);
};
