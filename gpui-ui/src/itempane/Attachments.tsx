// Attachments: file / link children with open in reader tab, show file, open in default app, rename, move to trash.
// Port of ui/src/itempane/Attachments.tsx.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { DropdownMenu, toast, type MenuItem } from "../ui";
import { findFullText, openLink } from "./actions";
import { Empty, Field, IconBtn, Section, TextBtn, t, tok, tx } from "./kit";
import { fail, usePane } from "./model";
import { ipApi, type ChildSummary } from "./net";

function iconFor(c: ChildSummary): { name: string; color: string } {
	const ct = c.contentType ?? "";
	if (c.linkMode === "linked_url") return { name: "link", color: "#0ea5e9" };
	if (/pdf/i.test(ct)) return { name: "file-text", color: "#ef4444" };
	if (/epub/i.test(ct)) return { name: "book-open", color: "#10b981" };
	if (/html/i.test(ct)) return { name: "globe", color: "#0ea5e9" };
	return { name: "paperclip", color: tok("muted-foreground") };
}

function AttachmentRow(p: { c: ChildSummary }): JSX.Element {
	const pane = usePane();
	const [hover, setHover] = createSignal(false);
	const [renaming, setRenaming] = createSignal(false);
	const c = () => p.c;
	const missing = () => c().linkMode !== "linked_url" && !c().hasFile;
	const guard = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { fail(what, e); } };

	const open = () => {
		const att = c();
		if (att.linkMode === "linked_url") {
			void guard("Could not open link", async () => {
				const url = ((await ipApi.item(att.key)).data.url as string | undefined) ?? "";
				if (url) await openLink(url);
			});
		} else if (att.hasFile) {
			store.openAttachment(att.key, pane.detail()?.data.title || att.title, pane.detail()?.data.key ?? "");
		}
	};
	const rename = (title: string) => {
		setRenaming(false);
		if (!title.trim() || title === c().title) return;
		void guard("Could not rename attachment", async () => { await ipApi.patchItem(c().key, { title }); await pane.reload(); });
	};
	const trash = () => void guard("Could not move attachment to Trash", async () => { await ipApi.setDeleted(c().key, true); await pane.reload(); pane.refreshList(); });
	const renameFile = () =>
		void guard("Could not rename file", async () => {
			const r = (await ipApi.renameFiles([c().key]))[0];
			toast(r?.status === "renamed" ? "File renamed from the item's metadata" : "File not renamed", { kind: r?.status === "renamed" ? "success" : "info", description: r?.status === "renamed" ? undefined : r?.message ?? r?.status });
			await pane.reload();
		});

	const menu = (): MenuItem[] => [
		{ label: "Rename", icon: "pencil", onSelect: () => setRenaming(true) },
		{ label: "Rename file from parent metadata", icon: "file-pen", disabled: !c().hasFile, onSelect: renameFile },
		{ separator: true },
		{ label: "Move Attachment to Trash", icon: "trash-2", danger: true, onSelect: trash },
	];
	const ic = () => iconFor(c());

	return (
		<div
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			onClick={(e) => { if (((e as { clickCount?: number }).clickCount ?? 1) >= 2 && !renaming()) open(); }}
			style={{ ...t("flex items-center gap-1.5 rounded px-1.5 py-[3px] w-full"), backgroundColor: hover() ? tok("accent") : "transparent" }}
		>
			<div style={{ opacity: missing() ? 0.4 : 1, flexShrink: 0 }}><Icon name={ic().name} size={16} color={ic().color} /></div>
			<Show
				when={!renaming()}
				fallback={<Field startEditing value={c().title} onSave={rename} onEditing={(e) => { if (!e) setRenaming(false); }} rootStyle={{ flexGrow: 1, width: "auto" }} />}
			>
				<text
					style={{
						...tx("text-[13px]"),
						flexGrow: 1, flexShrink: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
						...(missing() ? { color: tok("muted-foreground"), textDecoration: "line-through" } : {}),
					}}
				>
					{c().title || "Attachment"}
				</text>
			</Show>
			<Show when={missing()}>
				<div style={{ ...t("flex flex-none rounded px-1"), backgroundColor: tok("warning") }}>
					<text style={{ ...tx("text-[11px]"), color: tok("warning-foreground"), whiteSpace: "nowrap" }}>File missing</text>
				</div>
			</Show>
			<Show when={c().annotationCount > 0}>
				<div style={{ ...t("flex flex-none items-center gap-0.5") }}>
					<Icon name="message-square-text" size={12} color={tok("muted-foreground")} />
					<text style={{ ...tx("text-[11px] text-muted-foreground") }}>{String(c().annotationCount)}</text>
				</div>
			</Show>
			<Show when={hover() && !renaming()}>
				<div style={{ ...t("flex flex-none items-center"), }} onClick={(e) => (e as { stopPropagation?: () => void }).stopPropagation?.()}>
					<Show when={c().hasFile || c().linkMode === "linked_url"}>
						<IconBtn icon="book-open" title={c().linkMode === "linked_url" ? "Open link" : "Open in reader tab"} onClick={open} />
					</Show>
					<Show when={c().hasFile}>
						<IconBtn icon="folder-open" title="Show File" onClick={() => void guard("Could not show file", () => ipApi.reveal(c().key))} />
						<IconBtn icon="external-link" title="Open in default app" onClick={() => void guard("Could not open file", () => ipApi.openExternal(c().key))} />
					</Show>
					<DropdownMenu align="end" width={240} items={menu} trigger={<IconBtn icon="ellipsis" title="More" />} />
				</div>
			</Show>
		</div>
	);
}

export function AttachmentsSection(): JSX.Element {
	const pane = usePane();
	const atts = () => pane.detail()!.children.filter((c) => c.itemType === "attachment");
	return (
		<Section
			id="attachments"
			title="Attachments"
			icon="paperclip"
			count={atts().length}
			actions={<TextBtn icon="file-search" label="Find Full Text" title="Find an open-access or institutional PDF and attach it" onClick={() => void findFullText([pane.detail()!.data.key], () => void pane.reload())} />}
		>
			<Show when={atts().length} fallback={<Empty text="No attachments" />}>
				<For each={atts()}>{(c) => <AttachmentRow c={c} />}</For>
			</Show>
		</Section>
	);
}
