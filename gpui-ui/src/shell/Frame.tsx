// Draws a view's frame from its layout (docs/developer-guide/layouts.md, sections 3 and 5): the left column (fixed content), the
// centre column and the right column, each column a Resizable of the stacks it holds, each stack showing one of its panes.
//
// Nothing is removed from the tree to hide it. GPUIX destroys a removed element's native state (scroll offsets, cached views),
// so a hidden column, stack or pane stays mounted and is just not drawn (Resizable `shown`, display:none). Hiding the sidebar or
// the item pane therefore no longer rebuilds the item list, which keeps its scroll position. Each pane is created once per frame.
// Moving a pane to another stack (phase 2) will need it inserted into its new place before its old one is removed.
import { createMemo, For, getOwner, runWithOwner, untrack, type JSX } from "solid-js";
import { Resizable } from "../ui";
import { drawnColumns, stackFace, type Column, type ColumnId, type Stack, type ViewKind, type ViewLayout } from "./frameLayout";
import { paneDef, panesOf } from "./panes";

/** The canvas gap between cards, which is also the resize handles' hit area (as before layouts). */
const GUTTER = 12;
/** Least column fractions, as the fixed layout had them (sidebar 0.1, list 0.25, item pane 0.15). */
const MIN_FRACTION: Record<ColumnId, number> = { left: 0.1, centre: 0.25, right: 0.15 };

const FILL = { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0 } as const;
const OFF = { display: "none", width: 0, height: 0 } as const;

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** A stack's identity while the layout only resizes and shows/hides: its panes. */
const stackKey = (s: Stack) => s.panes.join("\u0001");

export function Frame(p: {
	view: ViewKind;
	layout: () => ViewLayout;
	setLayout: (l: ViewLayout) => void;
	/** the left column's fixed content (the sidebar) */
	left: () => JSX.Element;
	/** least width of the left column in px */
	leftMinPx?: number;
}): JSX.Element {
	const owner = getOwner();
	const registered = createMemo(() => new Set(panesOf(p.view).map((d) => d.id)));

	// one element per pane, created under the frame (not under whatever first asks for it), so it outlives layout changes
	const made = new Map<string, JSX.Element>();
	const paneEl = (id: string): JSX.Element => {
		let el = made.get(id);
		if (el === undefined) {
			const def = paneDef(id);
			el = runWithOwner(owner, () =>
				untrack(() => (
					<div testId={`pane-${id}`} style={FILL}>
						{def?.render()}
					</div>
				)),
			);
			made.set(id, el);
		}
		return el;
	};

	/** One stack: all its registered panes mounted, the face drawn. */
	const StackView = (q: { which: "centre" | "right"; key: string }): JSX.Element => {
		const stack = () => p.layout()[q.which].stacks.find((s) => stackKey(s) === q.key);
		const face = () => {
			const s = stack();
			return s ? stackFace(p.layout(), s, registered()) : null;
		};
		const panes = createMemo(() => (stack()?.panes ?? []).filter((id) => registered().has(id)), [], { equals: sameList });
		return (
			<div testId={`stack-${q.key.split("\u0001")[0]}`} style={FILL}>
				<For each={panes()}>{(id) => <div style={face() === id ? FILL : OFF}>{paneEl(id)}</div>}</For>
			</div>
		);
	};

	const ColumnView = (q: { which: "centre" | "right" }): JSX.Element => {
		const col = (): Column => p.layout()[q.which];
		const keys = createMemo(() => col().stacks.map(stackKey), [], { equals: sameList });
		const facePane = (k: string) => {
			const s = col().stacks.find((x) => stackKey(x) === k);
			return s ? stackFace(p.layout(), s, registered()) : null;
		};
		return (
			<div testId={`column-${q.which}`} style={FILL}>
				<Resizable
					dir="column"
					gutter={GUTTER}
					line={false}
					sizes={col().sizes}
					shown={keys().map((k) => facePane(k) !== null)}
					minPx={keys().map((k) => paneDef(facePane(k) ?? "")?.minSize.h ?? 0)}
					onSizes={(s) => p.setLayout({ ...p.layout(), [q.which]: { ...col(), sizes: s } })}
				>
					<For each={keys()}>{(k) => <StackView which={q.which} key={k} />}</For>
				</Resizable>
			</div>
		);
	};

	const cols = createMemo(() => drawnColumns(p.layout(), registered()), [], { equals: sameList });
	/** least width of a column: the widest minimum of the panes it draws */
	const minPx = (c: ColumnId): number => {
		if (c === "left") return p.leftMinPx ?? 0;
		const l = p.layout();
		const faces = l[c].stacks.map((s) => stackFace(l, s, registered()));
		return Math.max(0, ...faces.map((f) => (f ? (paneDef(f)?.minSize.w ?? 0) : 0)));
	};
	const ORDER: ColumnId[] = ["left", "centre", "right"];

	return (
		<Resizable
			gutter={GUTTER}
			line={false}
			sizes={p.layout().sizes}
			shown={ORDER.map((c) => cols().includes(c))}
			minSizes={ORDER.map((c) => MIN_FRACTION[c])}
			minPx={ORDER.map(minPx)}
			onSizes={(s) => p.setLayout({ ...p.layout(), sizes: [s[0]!, s[1]!, s[2]!] })}
		>
			<div testId="column-left" style={FILL}>
				{p.left()}
			</div>
			<ColumnView which="centre" />
			<ColumnView which="right" />
		</Resizable>
	);
}
