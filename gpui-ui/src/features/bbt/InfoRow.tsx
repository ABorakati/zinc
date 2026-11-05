// The "Citation Key" row of the item pane's Info section: the key (generated or pinned) with Pin / Unpin / Refresh buttons.
// Committing an edited key pins that value. Replaces the plain `citationKey` field row.
import { createEffect, createSignal, on, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Block, Field, IconBtn, Row, t, tok } from "../../itempane/kit";
import { fail, usePane } from "../../itempane/model";
import { bbtApi, bbtRev, bumpBbt, type KeyInfo } from "./client";
import { hasCitationKey, pinTarget } from "./logic";

export const CITATION_KEY_FIELD = "citationKey";

function CitationKeyRow(): JSX.Element {
	const pane = usePane();
	const [info, setInfo] = createSignal<KeyInfo | null>(null);
	const [busy, setBusy] = createSignal(false);
	const key = () => pane.itemKey();

	let seq = 0;
	const load = (k: string | undefined) => {
		const my = ++seq;
		if (!k) { setInfo(null); return; }
		bbtApi.keys([k]).then((r) => { if (my === seq) setInfo(r[k] ?? null); }, () => { if (my === seq) setInfo(null); });
	};
	// re-read on item change, after an edit of the item (its data version changes) and when keys changed elsewhere (settings, refresh)
	createEffect(on([key, () => pane.detail()?.data.version, bbtRev], ([k]) => { if (k !== key()) setInfo(null); load(k); }));

	const run = async (what: string, fn: (k: string) => Promise<KeyInfo | unknown>) => {
		const k = key();
		if (!k || busy()) return;
		setBusy(true);
		try { await fn(k); load(k); bumpBbt(); pane.refreshList(); }
		catch (e) { fail(what, e); }
		finally { setBusy(false); }
	};
	const pin = (v?: string) => void run("Could not pin the citation key", (k) => bbtApi.pin(k, v));
	const unpin = () => void run("Could not unpin the citation key", (k) => bbtApi.unpin(k));
	const refresh = () => void run("Could not refresh the citation key", (k) => bbtApi.refresh([k]));

	return (
		<Row label="Citation Key" icon="key-round">
			<div style={{ ...t("flex items-start w-full min-w-0 gap-0.5") }}>
				<div style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
					<Field
						nowrap
						value={info()?.key ?? ""}
						placeholder={info() ? "" : "…"}
						onSave={(v) => { const target = pinTarget(v, info()?.key ?? ""); if (target) pin(target); }}
						end={<Show when={info()?.pinned}><div style={{ marginLeft: 4, paddingTop: 2 }}><Icon name="pin" size={13} color={tok("primary")} /></div></Show>}
					/>
				</div>
				<div style={{ ...t("flex flex-none items-center"), paddingTop: 2 }}>
					<Show
						when={info()?.pinned}
						fallback={<IconBtn icon="pin" size={13} title="Pin this citation key" disabled={!info() || busy()} onClick={() => pin()} />}
					>
						<IconBtn icon="pin-off" size={13} title="Unpin (regenerate from the formula)" disabled={busy()} onClick={unpin} />
					</Show>
					<IconBtn icon="refresh-cw" size={13} title="Refresh the citation key" disabled={!info() || !!info()?.pinned || busy()} onClick={refresh} />
				</div>
			</div>
		</Row>
	);
}

/** The Info entry's content; nothing for notes, attachments and annotations. */
export function CitationKeyBlock(p: { itemType: string }): JSX.Element {
	return (
		<Show when={hasCitationKey(p.itemType)}>
			<Block><CitationKeyRow /></Block>
		</Show>
	);
}
