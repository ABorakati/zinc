// Info rows registered by plugins (`extend.register-info-row`): label + value rows inside the item pane's Details section. The value comes
// from the plugin (`on-info-row-get`, cached, one call per row and item); an editable row sends edits to `on-info-row-set`.
import { createSignal, Show, type JSX } from "solid-js";
import { Block, Row, tx, type Entry } from "../../itempane/kit";
import { Field } from "../../itempane/kit";
import { store } from "../../store";
import { conditionContext, currentTabRef } from "./context";
import { conditionHolds } from "./conditions";
import { infoRowValue, setInfoRow } from "./data";
import { registries, type Owned } from "./registry";
import { lstr } from "./text";
import type { InfoRowRegistration } from "./wit";

function InfoRowView(p: { r: Owned<InfoRowRegistration>; itemKey: string }): JSX.Element {
	const value = () => infoRowValue(p.r.plugin, p.r.id, p.itemKey, currentTabRef(), store.canEdit(), store.itemsRev());
	const [bump, setBump] = createSignal(0);
	const editable = () => p.r.reg.editable && (value()?.editable ?? false) && store.canEdit();
	return (
		<Block>
			<Row label={lstr(p.r.reg.label, p.r.id)}>
				<Show
					when={editable()}
					fallback={
						<text style={{ ...tx("text-[13px] text-muted-foreground"), paddingLeft: 6, paddingTop: 2, whiteSpace: p.r.reg.nowrap ? "nowrap" : "normal" }}>
							{(bump(), value()?.value ?? "")}
						</text>
					}
				>
					<Field
						value={value()?.value ?? ""}
						multiline={p.r.reg.multiline}
						onSave={(v) => {
							void setInfoRow(p.r.plugin, p.r.id, p.itemKey, currentTabRef(), v).then(() => setBump((n) => n + 1));
						}}
					/>
				</Show>
			</Row>
		</Block>
	);
}

/** Entries for the Info section at one position of an item (one entry per enabled row). */
export function pluginInfoEntries(position: InfoRowRegistration["position"], itemKey: string): Entry[] {
	const x = { ...conditionContext([itemKey]), tab: currentTabRef() };
	return registries.infoRows
		.list()
		.filter((r) => r.reg.position === position && conditionHolds(r.reg.enabledFor, x))
		.map((r) => ({ id: `plug:${r.plugin}:info:${r.id}`, section: "info", render: () => <InfoRowView r={r} itemKey={itemKey} /> }));
}
