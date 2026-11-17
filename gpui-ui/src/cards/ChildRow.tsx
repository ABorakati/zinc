// The twisty and the child rows (attachments / notes of an opened item) of the cards; the table draws its own child row from the
// same pieces (childLook, Twisty) in table/Table.tsx.
import { Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import type { ChildSummary } from "../api";
import type { Mode } from "../contracts";
import { clipText } from "../clip";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import { childIcon, childLabel } from "./actions";
import { isDoubleClick, selectChild, selectedChild } from "./children";
import { swallow, swallowed } from "./click";
import { focusList, setListFocused } from "./keys";
import { cardLayout, cardListWidth } from "./layout";
import { mix } from "./logic";
import type { ChildRow } from "./rows";
import { openChildRow } from "./tree";

const tok = (name: string, m: Mode) => tokens[m][name]!;

/** Icon and its colour for a child: as the item pane's attachment rows (PDF red, EPUB green, snapshot / link blue). */
export function childLook(c: ChildSummary, m: Mode): { icon: string; color: string } {
	const icon = childIcon(c);
	const ct = c.contentType ?? "";
	const color =
		c.itemType === "note"
			? "#d4a017"
			: c.linkMode === "linked_url" || /html/i.test(ct)
				? "#0ea5e9"
				: /pdf/i.test(ct)
					? "#ef4444"
					: /epub/i.test(ct)
						? "#10b981"
						: tok("muted-foreground", m);
	return { icon, color };
}
export { childLabel };

/** Zotero's twisty: a chevron that opens / closes the item's child rows (the click does not select the row). */
export function Twisty(p: { open: boolean; onToggle: () => void; size?: number; testId?: string }): JSX.Element {
	const s = () => p.size ?? 18;
	return (
		<div
			testId={p.testId}
			onClick={() => {
				swallow();
				p.onToggle();
			}}
			style={{
				...tw("flex flex-none items-center justify-center rounded cursor-pointer hover:bg-foreground/10", store.mode()),
				width: s(),
				height: s(),
			}}
		>
			<Icon name={p.open ? "chevron-down" : "chevron-right"} size={s() - 4} color={tok("muted-foreground", store.mode())} />
		</div>
	);
}

/** Click on a child row: select it (the item pane shows it); a double-click opens it as the pane's entries do. */
export function childClick(row: ChildRow) {
	return (e: EventPayload) => {
		if (swallowed() || !row.child) return;
		setListFocused(true);
		focusList();
		selectChild(row.parentKey, row.parentIndex, row.child.key);
		// the row may have been rebuilt between the two clicks (a refresh of the list): GPUI's count then starts again at 1
		if (isDoubleClick(row.child.key, e.clickCount ?? 1, performance.now())) openChildRow(row.parentIndex, row.child);
	};
}
export const isChildSelected = (row: ChildRow) => !!row.child && selectedChild()?.key === row.child.key;

/** Indent of a card's child rows: lines their icon up under the card's title (row px 10 + card px 10 + type icon 22 + gap 12). */
const CARD_INDENT = 44;

/** A child row under a card. */
export function CardChildRow(p: { row: ChildRow }): JSX.Element {
	const m = () => store.mode();
	const compact = () => cardLayout.layout().density === "compact";
	const sel = () => isChildSelected(p.row);
	const look = () => (p.row.child ? childLook(p.row.child, m()) : null);
	const notes = () => p.row.child?.annotationCount ?? 0;
	const label = () => {
		const c = p.row.child;
		if (!c) return "";
		// the list's width less the indent, paddings and the annotation count
		const w = cardListWidth() - 20 - CARD_INDENT - 20 - (notes() ? 44 : 0);
		return clipText(childLabel(c), Math.max(40, w), 13);
	};
	return (
		<div
			testId="card-child-row"
			onClick={childClick(p.row)}
			style={{
				...tw("flex flex-col w-full flex-none px-2.5", m()),
				...(p.row.last ? { paddingBottom: 4, ...tw("border-b border-border/60", m()) } : {}),
			}}
		>
			<div
				style={{
					...tw("flex flex-row items-center gap-2 rounded-[7px] pr-2.5", m()),
					height: compact() ? 26 : 28,
					paddingLeft: CARD_INDENT,
					...(sel()
						? { backgroundColor: mix(tok("primary", m()), 10, tok("card", m())) }
						: { hover: { backgroundColor: mix(tok("accent", m()), 40, "transparent") } }),
				}}
			>
				<Show when={look()} fallback={<div style={{ ...tw("bg-primary/10 rounded", m()), height: 10, width: 160 }} />}>
					{(l) => (
						<>
							<Icon name={l().icon} size={15} color={l().color} />
							<text
								style={{
									...textStyle("select-none text-[13px] text-foreground/85", m()),
									whiteSpace: "nowrap",
									flexGrow: 1,
									flexShrink: 1,
									minWidth: 0,
								}}
							>
								{label()}
							</text>
							<Show when={notes()}>
								<div style={tw("flex flex-none flex-row items-center gap-1", m())}>
									<Icon name="highlighter" size={13} color={tok("muted-foreground", m())} />
									<text style={textStyle("select-none text-xs tabular-nums text-muted-foreground", m())}>
										{String(notes())}
									</text>
								</div>
							</Show>
						</>
					)}
				</Show>
			</div>
		</div>
	);
}
