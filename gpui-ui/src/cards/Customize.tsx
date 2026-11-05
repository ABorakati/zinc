// "Customise rows": what each card shows (ui/src/cards/Customize.tsx), as a dialog opened from the sort bar's Customise button.
import { For, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { labelOf } from "../table/defs";
import { textStyle, tokens, tw } from "../theme";
import { Button, Checkbox, DropdownMenu, openDialog, Tabs, type MenuItem } from "../ui";
import { COMMON_FIELDS, getMetaField, otherFieldIds } from "./fields";
import { cardLayout, type CreatorsMode, type Density } from "./layout";

const mode = () => store.mode();
const t = (cls: string) => tw(cls, mode());
const tx = (cls: string) => textStyle(cls, mode());
const tok = (name: string) => tokens[mode()][name]!;

const CREATORS: { value: CreatorsMode; label: string }[] = [
	{ value: "full", label: "Full list" },
	{ value: "short", label: "3 + et al." },
	{ value: "summary", label: "Summary" },
	{ value: "off", label: "Hidden" },
];
const DENSITY: { value: Density; label: string }[] = [
	{ value: "comfortable", label: "Comfortable" },
	{ value: "compact", label: "Compact" },
];

/** A numbered section: `space-y-1.5 border-t pt-2.5 first:border-0` with an uppercase 11px heading. */
function Section(p: { n: number; title: string; first?: boolean; children: JSX.Element }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col gap-1.5 w-full"), ...(p.first ? {} : { borderTopWidth: 1, borderColor: tok("border"), paddingTop: 10 }) }}>
			<div style={t("flex flex-row items-center gap-1.5")}>
				<div style={{ ...t("flex items-center justify-center rounded bg-muted"), width: 16, height: 16 }}>
					<text style={tx("text-[10px] text-muted-foreground")}>{String(p.n)}</text>
				</div>
				<text style={tx("text-[11px] font-semibold text-muted-foreground")}>{p.title.toUpperCase()}</text>
			</div>
			{p.children}
		</div>
	);
}

function IconBtn(p: { icon: string; label: string; disabled?: boolean; onClick: () => void }): JSX.Element {
	return (
		<div
			role="button" aria-label={p.label}
			onClick={() => { if (!p.disabled) p.onClick(); }}
			style={{ ...t("flex size-5 items-center justify-center rounded hover:bg-accent"), opacity: p.disabled ? 0.3 : 1, cursor: p.disabled ? "default" : "pointer" }}
		>
			<Icon name={p.icon} size={12} color={tok("foreground")} />
		</div>
	);
}

function addFieldItems(): MenuItem[] {
	const remaining = (ids: string[]) => ids.filter((id) => !cardLayout.layout().meta.includes(id));
	const item = (id: string, label: string): MenuItem => ({ label, onSelect: () => cardLayout.addMeta(id) });
	return [
		{ heading: "Common" },
		...remaining(COMMON_FIELDS).map((id) => item(id, getMetaField(id).label)),
		{ separator: true },
		{ label: "All fields", submenu: remaining(otherFieldIds()).map((id) => item(id, labelOf(id))) },
	];
}

function CustomizeBody(): JSX.Element {
	const L = cardLayout.layout;
	return (
		<div style={{ ...t("flex flex-col gap-2.5"), width: "100%" }}>
			<Section n={1} title="Title line" first>
				<div style={t("flex flex-col gap-1.5")}>
					<Checkbox checked={L().star} onChange={(v) => cardLayout.set("star", v)} label="Star toggle" />
					<Checkbox checked={L().tags} onChange={(v) => cardLayout.set("tags", v)} label="Coloured tag badges" />
					<div style={{ opacity: L().tags ? 1 : 0.5 }}>
						<Checkbox checked={L().allTags} onChange={(v) => { if (L().tags) cardLayout.set("allTags", v); }} label="Also show uncoloured tags" />
					</div>
				</div>
			</Section>
			<Section n={2} title="Authors line">
				<Tabs value={L().creators} tabs={CREATORS} onChange={(v) => cardLayout.set("creators", v)} />
			</Section>
			<Section n={3} title="Details line">
				<div style={t("flex flex-col gap-1")}>
					<For each={L().meta} fallback={<text style={tx("text-xs text-muted-foreground")}>No fields</text>}>{(id, i) => (
						<div style={t("flex flex-row items-center gap-1 rounded-md border bg-background py-0.5 pl-2 pr-0.5")}>
							<text style={{ ...tx("text-xs text-foreground"), flexGrow: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{getMetaField(id).label}</text>
							<IconBtn icon="arrow-up" label="Move up" disabled={i() === 0} onClick={() => cardLayout.moveMeta(id, -1)} />
							<IconBtn icon="arrow-down" label="Move down" disabled={i() === L().meta.length - 1} onClick={() => cardLayout.moveMeta(id, 1)} />
							<IconBtn icon="x" label="Remove" onClick={() => cardLayout.removeMeta(id)} />
						</div>
					)}</For>
				</div>
				<DropdownMenu
					items={addFieldItems}
					width={200}
					trigger={
						<div style={{ ...t("flex flex-row items-center justify-between h-8 w-full rounded-md border border-input bg-background px-2 cursor-pointer"), pointerEvents: "none" /* filled: else it blocks the DropdownMenu's click */ }}>
							<text style={tx("text-xs text-muted-foreground")}>Add field…</text>
							<Icon name="chevron-down" size={14} color={tok("muted-foreground")} />
						</div>
					}
				/>
			</Section>
			<Section n={4} title="Icons line">
				<Checkbox checked={L().icons} onChange={(v) => cardLayout.set("icons", v)} label="Notes, PDF and attachments" />
			</Section>
			<Section n={5} title="Density">
				<Tabs value={L().density} tabs={DENSITY} onChange={(v) => cardLayout.set("density", v)} />
			</Section>
			<div style={t("flex flex-row justify-end gap-2 pt-1")}>
				<Button variant="ghost" size="sm" onClick={() => cardLayout.reset()}>Reset</Button>
			</div>
		</div>
	);
}

/** Open the card customiser. */
export function openCustomize(): void {
	void openDialog<void>(() => <CustomizeBody />, { title: "Customise rows", width: 340 });
}
