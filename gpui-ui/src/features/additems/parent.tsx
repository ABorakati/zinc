// "Create Parent Item" for a standalone attachment or note (Zotero's createParentDialog): the parent comes from an identifier
// (the add-by-identifier code) or is an empty item of a chosen type; the attachment or note then moves under it.
import { createMemo, createSignal, For, onMount, type JSX } from "solid-js";
import { Icon, itemTypeIconName } from "../../icons";
import { Button, openDialog, TextInput } from "../../ui";
import { DialogBody } from "./dialogs";
import { ErrorLine, Field, Footer, Para, Row, Scroll, Txt, t, tok } from "../kit";
import { get } from "../http";
import { errMsg } from "../text";
import type { ZoteroSchema } from "../types";
import { createParentFor } from "./client";

const CHILD_TYPE: Record<string, true> = { attachment: true, note: true, annotation: true };

function CreateParentDialog(p: { itemKey: string; close: () => void }): JSX.Element {
	const [schema, setSchema] = createSignal<ZoteroSchema | null>(null);
	const [loadError, setLoadError] = createSignal("");
	const [text, setText] = createSignal("");
	const [itemType, setItemType] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	onMount(() => void get<ZoteroSchema>("/api/schema").then(setSchema, (e) => setLoadError(errMsg(e))));

	const types = createMemo(() => (schema()?.itemTypes ?? []).filter((x) => !CHILD_TYPE[x.itemType]));
	/** The identifier wins while it has text; else the chosen item type. */
	const choice = (): { text?: string; itemType?: string } | null => {
		const t = text().trim();
		if (t) return { text: t };
		return itemType() ? { itemType: itemType() } : null;
	};

	async function submit() {
		const c = choice();
		if (!c || busy()) return;
		setBusy(true);
		setError("");
		try {
			await createParentFor(p.itemKey, c);
			p.close();
		} catch (e) {
			setError(errMsg(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<DialogBody>
			<Para class="text-sm text-muted-foreground">The new item becomes the parent of the selected attachment or note.</Para>
			<Field label="Enter a DOI, ISBN, PMID or arXiv ID">
				<TextInput
					autofocus
					value={text()}
					onInput={setText}
					onEnter={() => void submit()}
					placeholder="10.1136/bmj-2023-078378"
				/>
			</Field>
			<div style={{ ...t("flex flex-col"), width: "100%" }}>
				<Txt class="text-xs text-muted-foreground">Or create an empty parent of the item type you pick:</Txt>
			</div>
			<Scroll height={220} border>
				<For
					each={types()}
					fallback={<div style={t("px-2 py-3")}><Txt class="text-xs text-muted-foreground">{loadError() || (schema() ? "No item types" : "Loading…")}</Txt></div>}
				>
					{(x) => (
						<Row
							selected={!text().trim() && itemType() === x.itemType}
							onClick={() => { setItemType(x.itemType); setText(""); }}
							style={{ flexShrink: 0 }}
						>
							<Icon name={itemTypeIconName(x.itemType)} size={16} color={tok("muted-foreground")} />
							<Txt class="text-[13px] text-foreground">{x.label}</Txt>
						</Row>
					)}
				</For>
			</Scroll>
			<ErrorLine>{error()}</ErrorLine>
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={busy() || !choice()} onClick={() => void submit()}>
					{busy() ? "Creating…" : "Create"}
				</Button>
			</Footer>
		</DialogBody>
	);
}

export const openCreateParentDialog = (itemKey: string) =>
	openDialog<void>((close) => <CreateParentDialog itemKey={itemKey} close={() => close()} />, { title: "Create Parent Item", width: 420 });
