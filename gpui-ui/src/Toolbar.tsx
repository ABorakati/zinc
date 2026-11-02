// Toolbar (quick-search mode, search box, List/Classic toggle, Tools, Add) and the Group / Sort bar under it.
// Mirrors Toolbar in ui/src/App.tsx, QuickSearchMode.tsx and SortBar.tsx with the same class strings.
import { createSignal, For } from "solid-js";
import type { Mode, Style } from "./contracts";
import { Icon } from "./icons";
import { store } from "./store";
import { shadows, textStyle, tokens, tw, type BoxShadow } from "./theme";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());
const tx = (cls: string): Style => textStyle(cls, mode());
const tok = (name: string): string => tokens[mode()][name] ?? "#888";

const QUICK_LABELS: Record<string, string> = {
	titleCreatorYear: "Title, Creator, Year",
	fields: "All Fields & Tags",
	everything: "Everything",
};

/** QuickSearchMode: h-9 max-w-36 rounded-lg border border-input bg-background pl-1.5 pr-6 text-xs text-muted-foreground. */
function QuickSearchMode() {
	return (
		<div
			// a static label is fine for the spike: click cycles through the modes
			onClick={() => {
				const order = ["titleCreatorYear", "fields", "everything"] as const;
				store.setQMode(order[(order.indexOf(store.qmode()) + 1) % order.length]!);
			}}
			style={{
				...t("relative flex h-9 flex-none items-center justify-between rounded-lg border border-input bg-background pl-2 pr-2"),
				width: 144,
				cursor: "pointer",
			}}
		>
			<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
				{QUICK_LABELS[store.qmode()] ?? "Title, Creator, Year"}
			</text>
			<Icon name="chevron-down" size={14} color={tok("muted-foreground")} />
		</div>
	);
}

/** Search box: icon at left-3 over a h-9 rounded-lg bg-muted field with pl-9. */
function SearchBox() {
	return (
		<div style={t("relative flex h-9 min-w-0 flex-1 items-center rounded-lg bg-muted")}>
			<div style={{ position: "absolute", left: 12, top: 0, bottom: 0, display: "flex", alignItems: "center", pointerEvents: "none" }}>
				<Icon name="search" size={15} color={tok("muted-foreground")} />
			</div>
			<input
				value={store.filter()}
				placeholder="Search titles, authors, year…"
				onChange={(e) => store.setFilter((e as { value?: string }).value ?? "")}
				style={{
					flexGrow: 1,
					minWidth: 0,
					height: 36,
					paddingLeft: 36,
					paddingRight: 12,
					fontSize: 13,
					fontFamily: "Inter",
					color: tok("foreground"),
				}}
				theme={{
					appearance: mode(),
					bg: tok("muted"),
					text: tok("foreground"),
					textMuted: tok("muted-foreground"),
					textFaint: tok("muted-foreground"),
					textDim: tok("muted-foreground"),
					accent: tok("primary"),
					caret: tok("primary"),
					fontSans: "Inter",
				}}
			/>
		</div>
	);
}

/** View toggle: inline-flex rounded-lg bg-muted p-[3px]; buttons h-[30px] rounded-md px-2.5 text-[13px] gap-1.5. */
function ViewToggle() {
	const [view, setView] = createSignal<"cards" | "table">("cards");
	const items = [
		{ id: "cards" as const, text: "List", icon: "layout-list" },
		{ id: "table" as const, text: "Classic", icon: "table-2" },
	];
	return (
		<div style={t("flex flex-none rounded-lg bg-muted p-[3px]")}>
			<For each={items}>{(m) => {
				const on = () => view() === m.id;
				return (
					<div
						onClick={() => setView(m.id)}
						style={{
							...t("flex h-[30px] items-center gap-1.5 rounded-md px-2.5"),
							cursor: "pointer",
							...(on() ? { backgroundColor: tok("background"), boxShadow: tw("shadow-sm", mode()).boxShadow as BoxShadow[] } : {}),
						}}
					>
						<Icon name={m.icon} size={14} color={tok(on() ? "foreground" : "muted-foreground")} />
						<text style={tx(on() ? "text-[13px] font-medium text-foreground" : "text-[13px] text-muted-foreground")}>{m.text}</text>
					</div>
				);
			}}</For>
		</div>
	);
}

/** Tools: size-8 rounded-lg icon button. */
function ToolsButton() {
	return (
		<div style={{ ...t("flex size-8 flex-none items-center justify-center rounded-lg"), cursor: "pointer", hover: t("bg-foreground/5") }}>
			<Icon name="wrench" size={16} color={tok("muted-foreground")} />
		</div>
	);
}

/** Add: h-9 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-primary. */
function AddButton() {
	return (
		<div
			style={{
				...t("flex h-9 flex-none items-center gap-1.5 rounded-lg bg-primary px-3.5"),
				boxShadow: shadows[mode()].primary,
				cursor: "pointer",
			}}
		>
			<Icon name="plus" size={14} color={tok("primary-foreground")} />
			<text style={tx("text-[13px] font-medium text-primary-foreground")}>Add</text>
		</div>
	);
}

/** flex flex-none items-center gap-2.5 border-b border-border-soft px-4 pt-3.5 pb-2.5 */
export function Toolbar() {
	return (
		<div style={{ ...t("flex flex-none items-center gap-2.5 border-b border-border-soft px-4 pt-3.5 pb-2.5"), width: "100%" }}>
			<QuickSearchMode />
			<SearchBox />
			<ViewToggle />
			<ToolsButton />
			<AddButton />
		</div>
	);
}

// ---- Group / Sort bar (SortBar.tsx), static chips for the default List view: Group Year, Sort 1 Year, 2 Date Added ----

const chipBase = "flex h-[26px] flex-none items-center rounded-full border";

function LevelChip(p: { n: number; label: string; arrow: string }) {
	return (
		<div style={t(`${chipBase} border-border bg-card`)}>
			<div style={t("flex h-full items-center gap-1.5 pl-2.5 pr-1")}>
				<text style={tx("text-xs font-semibold text-foreground/90")}>{String(p.n)}</text>
				<text style={tx("text-xs text-foreground/90")}>{p.label}</text>
			</div>
			<div style={t("flex h-full min-w-6 items-center justify-center pl-1 pr-2.5")}>
				<text style={tx("text-xs text-muted-foreground")}>{p.arrow}</text>
			</div>
		</div>
	);
}

/** flex flex-wrap items-center gap-2 border-b px-5 py-1.5 text-xs text-muted-foreground */
export function SortBar() {
	const count = () => `${store.total().toLocaleString("en-GB")} ${store.total() === 1 ? "item" : "items"}`;
	return (
		// no wrapping: GPUI's text runs a little wider than Chromium's, which pushed Customise onto a second row the web UI doesn't have
		<div style={{ ...t("flex flex-none items-center gap-2 border-b px-5 py-1.5"), width: "100%", overflow: "hidden" }}>
			<div style={t("flex items-center gap-1.5")}>
				<Icon name="layout-panel-top" size={14} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Group</text>
			</div>
			<div style={t(`${chipBase} gap-1 border-primary/25 bg-primary/10 px-2.5`)}>
				<text style={tx("text-xs font-medium text-primary")}>Year</text>
				<Icon name="chevron-down" size={12} color={tok("primary")} />
			</div>
			<div style={t("h-4 w-px bg-border mx-1")} />
			<div style={t("flex items-center gap-1.5")}>
				<Icon name="arrow-down-up" size={14} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Sort</text>
			</div>
			<LevelChip n={1} label="Year" arrow="↓" />
			<text style={tx("text-xs text-muted-foreground")}>›</text>
			<LevelChip n={2} label="Date Added" arrow="↓" />
			<div style={t(`${chipBase} gap-1 border-dashed border-border px-2`)}>
				<Icon name="plus" size={12} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Add level</text>
			</div>
			<div style={{ flexGrow: 1 }} />
			<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{count()}</text>
			{/* Customise (cards view trailing control): ghost button with a sliders icon */}
			<div style={{ ...t("flex h-6 items-center gap-1.5 rounded-md px-2"), cursor: "pointer", hover: t("bg-foreground/5") }}>
				<Icon name="settings-2" size={14} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Customise</text>
			</div>
		</div>
	);
}
