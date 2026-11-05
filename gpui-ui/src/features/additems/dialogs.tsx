// Add Item by Identifier, New Item, Link to File, Link to URI. Each opens through openDialog(); the dialog state lives in the component.
import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { Icon, itemTypeIconName } from "../../icons";
import { Button, openDialog, TextInput } from "../../ui";
import { ErrorLine, Field, Footer, Para, Row, Scroll, t, tok, Txt } from "../kit";
import { get } from "../http";
import { pickPaths, readClipboardText } from "../platform";
import { errMsg, looksLikeIdentifiers } from "../text";
import type { ZoteroSchema } from "../types";
import { addByIdentifier, addLinkedFile, addLinkedUri, createNewItem } from "./client";

const Body = (p: { children: JSX.Element }) => <div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>{p.children}</div>;

export { Body as DialogBody };

function IdentifierDialog(p: { initial: string; close: () => void }): JSX.Element {
	const [text, setText] = createSignal(p.initial);
	const [busy, setBusy] = createSignal(false);
	async function submit() {
		if (!text().trim() || busy()) return;
		setBusy(true);
		const r = await addByIdentifier(text());
		setBusy(false);
		if (r && !r.failed.length) p.close();
		else if (r) setText(r.failed.map((f) => f.id).join("\n")); // keep only what failed so it can be fixed and retried
	}
	return (
		<Body>
			<Para class="text-sm text-muted-foreground">DOI, PMID, PMCID, arXiv ID or ISBN. Separate several with new lines or commas.</Para>
			<TextInput multiline autofocus value={text()} onInput={setText} placeholder={"10.1136/bmj-2023-078378\n31452104\narXiv:1706.03762\n978-0-13-468599-1"} style={{ height: 128 }} />
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={busy() || !text().trim()} onClick={() => void submit()}>{busy() ? "Adding…" : "Add"}</Button>
			</Footer>
		</Body>
	);
}

/** Opens the dialog; with no text, identifiers found on the clipboard are offered as the starting text. */
export async function openIdentifierDialog(initial?: string): Promise<void> {
	let text = initial ?? "";
	if (!text) {
		try {
			const clip = (await readClipboardText()).trim();
			if (looksLikeIdentifiers(clip)) text = clip;
		} catch { /* no clipboard access: start empty */ }
	}
	await openDialog<void>((close) => <IdentifierDialog initial={text} close={() => close()} />, { title: "Add Item by Identifier", width: 480 });
}

function NewItemDialog(p: { close: () => void }): JSX.Element {
	const [schema, setSchema] = createSignal<ZoteroSchema | null>(null);
	const [error, setError] = createSignal("");
	const [q, setQ] = createSignal("");
	onMount(() => void get<ZoteroSchema>("/api/schema").then(setSchema, (e) => setError(errMsg(e))));
	const types = createMemo(() => {
		const s = q().trim().toLowerCase();
		return (schema()?.itemTypes ?? [])
			.filter((x) => !["attachment", "note", "annotation"].includes(x.itemType))
			.filter((x) => !s || x.label.toLowerCase().includes(s) || x.itemType.toLowerCase().includes(s));
	});
	const pick = (type: string) => { p.close(); void createNewItem(type); };
	return (
		<Body>
			<Txt class="text-sm text-muted-foreground">Choose an item type.</Txt>
			<TextInput autofocus value={q()} onInput={setQ} placeholder="Search item types…" onEnter={() => { const f = types()[0]; if (f) pick(f.itemType); }} />
			<Scroll height={288} border>
				<For each={types()} fallback={<div style={t("px-2 py-3")}><Txt class="text-xs text-muted-foreground">{error() || (schema() ? "No matching item types" : "Loading…")}</Txt></div>}>
					{(x) => (
						<Row onClick={() => pick(x.itemType)} style={{ flexShrink: 0 }}>
							<Icon name={itemTypeIconName(x.itemType)} size={16} color={tok("muted-foreground")} />
							<Txt class="text-[13px] text-foreground">{x.label}</Txt>
						</Row>
					)}
				</For>
			</Scroll>
		</Body>
	);
}
export const openNewItemDialog = () => openDialog<void>((close) => <NewItemDialog close={() => close()} />, { title: "New Item", width: 380 });

function LinkFileDialog(p: { parentKey?: string; close: () => void }): JSX.Element {
	const [path, setPath] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	async function submit() {
		if (!path().trim() || busy()) return;
		setBusy(true);
		const ok = await addLinkedFile(path(), p.parentKey);
		setBusy(false);
		if (ok) p.close();
	}
	async function browse() {
		const got = await pickPaths({ files: true, prompt: "Link" });
		if (got?.[0]) setPath(got[0]);
	}
	return (
		<Body>
			<Para class="text-sm text-muted-foreground">Full path of a file on this computer. The file stays where it is.</Para>
			<div style={t("flex flex-row items-center gap-2")}>
				<div style={{ flexGrow: 1, minWidth: 0 }}><TextInput autofocus value={path()} onInput={setPath} onEnter={() => void submit()} placeholder="C:\Users\you\Documents\paper.pdf" /></div>
				<Button variant="outline" size="sm" icon="folder-open" onClick={() => void browse()}>Browse…</Button>
			</div>
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={busy() || !path().trim()} onClick={() => void submit()}>Link</Button>
			</Footer>
		</Body>
	);
}
export const openLinkFileDialog = (parentKey?: string) => openDialog<void>((close) => <LinkFileDialog parentKey={parentKey} close={() => close()} />, { title: "Link to File", width: 480 });

function LinkUriDialog(p: { parentKey?: string; close: () => void }): JSX.Element {
	const [url, setUrl] = createSignal("");
	const [title, setTitle] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [err, setErr] = createSignal("");
	async function submit() {
		if (!url().trim() || busy()) return;
		setBusy(true);
		setErr("");
		const ok = await addLinkedUri(url(), title(), p.parentKey);
		setBusy(false);
		if (ok) p.close();
		else setErr("The address could not be added.");
	}
	return (
		<Body>
			<Para class="text-sm text-muted-foreground">Web address or other URI to attach.</Para>
			<Field label="Address"><TextInput autofocus value={url()} onInput={setUrl} onEnter={() => void submit()} placeholder="https://…" /></Field>
			<Field label="Title (optional)"><TextInput value={title()} onInput={setTitle} onEnter={() => void submit()} /></Field>
			<ErrorLine>{err()}</ErrorLine>
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={busy() || !url().trim()} onClick={() => void submit()}>Add</Button>
			</Footer>
		</Body>
	);
}
export const openLinkUriDialog = (parentKey?: string) => openDialog<void>((close) => <LinkUriDialog parentKey={parentKey} close={() => close()} />, { title: "Link to URI", width: 440 });

export { Show };
