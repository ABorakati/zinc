// The formatting toolbar of the native note editor (RichTextEditor.tsx): buttons that run <richtext> commands and show their
// pressed state from the SelectionState the element reports. Colours and the link field open in a second row under the buttons.
import { createEffect, createSignal, For, on, Show, type Accessor, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { IconBtn, MiniSelect, t, tok, tx, BoxInput } from "../../itempane/kit";

/** What `<richtext>` reports through onSelectionChange (JSON). */
export interface SelectionState {
	marks: {
		bold: boolean;
		italic: boolean;
		underline: boolean;
		strike: boolean;
		code: boolean;
		script: "sub" | "sup" | null;
		textColor: string | null;
		bgColor: string | null;
		link: string | null;
	};
	block:
		| "paragraph"
		| "heading1"
		| "heading2"
		| "heading3"
		| "heading4"
		| "heading5"
		| "heading6"
		| "code"
		| "quote"
		| "math"
		| "bullet"
		| "ordered";
	inTable: boolean;
	canUndo: boolean;
	canRedo: boolean;
	collapsed: boolean;
}

export type Run = (name: string, args?: Record<string, unknown>) => void;
export type Panel = "textColor" | "bgColor" | "link" | null;

/** Preset swatches: the app's Quiet Paper accents for text, Zotero's annotation colours for highlights. */
export const TEXT_SWATCHES = ["#23221F", "#2B5FA8", "#2E8AB8", "#1F7A62", "#B76A12", "#C0532E", "#B2457A", "#6A4FC8"];
export const BG_SWATCHES = ["#ffd400", "#ff6666", "#5fb236", "#2ea8e5", "#a28ae5", "#e56eee", "#f19837", "#aaaaaa"];

const BLOCKS: { value: string; label: string; set?: string; toggle?: string }[] = [
	{ value: "paragraph", label: "Paragraph", set: "paragraph" },
	...[1, 2, 3, 4, 5, 6].map((n) => ({ value: `heading${n}`, label: `Heading ${n}`, set: `heading${n}` })),
	{ value: "code", label: "Code block", set: "code" },
	{ value: "quote", label: "Quote", toggle: "toggleQuote" },
	{ value: "bullet", label: "Bullet list", toggle: "toggleBulletList" },
	{ value: "ordered", label: "Numbered list", toggle: "toggleOrderedList" },
	{ value: "math", label: "Maths" },
];

function Sep(): JSX.Element {
	return <div style={{ width: 1, height: 16, flexShrink: 0, marginLeft: 3, marginRight: 3, backgroundColor: tok("border") }} />;
}

/** An icon button that stays highlighted while its format is on. */
function Tool(p: {
	icon: string;
	title: string;
	pressed?: boolean;
	disabled?: boolean;
	color?: string;
	onClick: () => void;
	testId?: string;
}): JSX.Element {
	return (
		<div
			style={{
				...t("flex flex-none items-center justify-center rounded"),
				backgroundColor: p.pressed ? tok("accent") : "transparent",
				borderWidth: 1,
				borderColor: p.pressed ? tok("border") : "transparent",
			}}
		>
			<IconBtn
				icon={p.icon}
				title={p.title}
				box={24}
				size={14}
				disabled={p.disabled}
				color={p.color ?? tok(p.pressed ? "foreground" : "muted-foreground")}
				onClick={p.onClick}
				testId={p.testId}
			/>
		</div>
	);
}

function Swatch(p: { color: string; selected: boolean; title: string; onClick: () => void }): JSX.Element {
	return (
		<div
			role="button"
			aria-label={p.title}
			onClick={p.onClick}
			style={{
				width: 18,
				height: 18,
				flexShrink: 0,
				borderRadius: 9,
				cursor: "pointer",
				backgroundColor: p.color,
				borderWidth: p.selected ? 2 : 1,
				borderColor: p.selected ? tok("foreground") : tok("border"),
			}}
		/>
	);
}

export function Toolbar(p: {
	state: Accessor<SelectionState | null>;
	run: Run;
	/** the open second row (colour swatches or the link field); owned by the editor so Ctrl+K can open it */
	panel: Accessor<Panel>;
	setPanel: (v: Panel) => void;
	disabled?: boolean;
}): JSX.Element {
	const m = () => p.state()?.marks;
	const block = () => p.state()?.block ?? "paragraph";
	const off = () => !!p.disabled;
	const toggle = (panel: Exclude<Panel, null>) => p.setPanel(p.panel() === panel ? null : panel);
	const mark = (icon: string, title: string, cmd: string, on: () => boolean | undefined) => (
		<Tool icon={icon} title={title} pressed={!!on()} disabled={off()} onClick={() => p.run(cmd)} testId={`rt-${cmd}`} />
	);

	// the link field: seeded with the link under the caret; Enter applies, an empty value removes the link
	const [href, setHref] = createSignal("");
	createEffect(
		on(
			() => p.panel() === "link",
			(open) => open && setHref(m()?.link ?? ""),
			{ defer: true },
		),
	);
	const applyLink = () => {
		const v = href().trim();
		p.run("setLink", { href: v === "" ? null : v });
		p.setPanel(null);
	};

	const colours = (kind: "textColor" | "bgColor") => {
		const cmd = kind === "textColor" ? "setTextColor" : "setBgColor";
		const list = kind === "textColor" ? TEXT_SWATCHES : BG_SWATCHES;
		return (
			<div style={{ ...t("flex flex-row flex-wrap items-center gap-1.5 px-1") }}>
				<text style={{ ...tx("text-[11px] text-muted-foreground") }}>{kind === "textColor" ? "Text colour" : "Highlight"}</text>
				<For each={list}>
					{(c) => (
						<Swatch
							color={c}
							title={c}
							selected={(m()?.[kind] ?? "").toLowerCase() === c.toLowerCase()}
							onClick={() => {
								p.run(cmd, { color: c });
								p.setPanel(null);
							}}
						/>
					)}
				</For>
				<IconBtn
					icon="x"
					title={kind === "textColor" ? "Clear text colour" : "Clear highlight"}
					box={20}
					size={12}
					onClick={() => {
						p.run(cmd, { color: null });
						p.setPanel(null);
					}}
				/>
			</div>
		);
	};

	return (
		<div testId="rt-toolbar" style={{ ...t("flex flex-col gap-1"), width: "100%", flexShrink: 0, opacity: off() ? 0.5 : 1 }}>
			<div style={{ ...t("flex flex-row flex-wrap items-center gap-0.5") }}>
				<MiniSelect
					value={block()}
					width={104}
					options={BLOCKS.map((b) => ({ value: b.value, label: b.label }))}
					onChange={(v) => {
						if (off()) return;
						const b = BLOCKS.find((x) => x.value === v);
						if (b?.set) p.run("setBlock", { type: b.set });
						else if (b?.toggle) p.run(b.toggle);
					}}
				/>
				<Sep />
				{mark("bold", "Bold (Ctrl+B)", "toggleBold", () => m()?.bold)}
				{mark("italic", "Italic (Ctrl+I)", "toggleItalic", () => m()?.italic)}
				{mark("underline", "Underline (Ctrl+U)", "toggleUnderline", () => m()?.underline)}
				{mark("strikethrough", "Strikethrough", "toggleStrike", () => m()?.strike)}
				{mark("code", "Code", "toggleCode", () => m()?.code)}
				{mark("subscript", "Subscript", "toggleSub", () => m()?.script === "sub")}
				{mark("superscript", "Superscript", "toggleSup", () => m()?.script === "sup")}
				<Sep />
				<Tool
					icon="baseline"
					title="Text colour"
					pressed={p.panel() === "textColor" || !!m()?.textColor}
					disabled={off()}
					color={m()?.textColor ?? undefined}
					onClick={() => toggle("textColor")}
				/>
				<Tool
					icon="highlighter"
					title="Highlight colour"
					pressed={p.panel() === "bgColor" || !!m()?.bgColor}
					disabled={off()}
					color={m()?.bgColor ?? undefined}
					onClick={() => toggle("bgColor")}
				/>
				<Tool
					icon="link"
					title="Link (Ctrl+K)"
					pressed={p.panel() === "link" || !!m()?.link}
					disabled={off()}
					onClick={() => toggle("link")}
				/>
				<Sep />
				<Tool
					icon="list"
					title="Bullet list"
					pressed={block() === "bullet"}
					disabled={off()}
					onClick={() => p.run("toggleBulletList")}
				/>
				<Tool
					icon="list-ordered"
					title="Numbered list"
					pressed={block() === "ordered"}
					disabled={off()}
					onClick={() => p.run("toggleOrderedList")}
				/>
				<Tool icon="quote" title="Quote" pressed={block() === "quote"} disabled={off()} onClick={() => p.run("toggleQuote")} />
				<Sep />
				<Tool icon="undo-2" title="Undo (Ctrl+Z)" disabled={off() || !p.state()?.canUndo} onClick={() => p.run("undo")} />
				<Tool icon="redo-2" title="Redo (Ctrl+Shift+Z)" disabled={off() || !p.state()?.canRedo} onClick={() => p.run("redo")} />
			</div>
			<Show when={p.panel() === "textColor" || p.panel() === "bgColor"}>{colours(p.panel() as "textColor" | "bgColor")}</Show>
			<Show when={p.panel() === "link"}>
				<div style={{ ...t("flex flex-row items-center gap-1 px-1") }}>
					<Icon name="link" size={12} color={tok("muted-foreground")} />
					<BoxInput
						autoFocus
						value={href()}
						placeholder="Link address (empty removes the link)"
						onInput={setHref}
						onCommit={() => applyLink()}
						onKey={(k) => k === "Escape" && p.setPanel(null)}
						style={{ flexGrow: 1, width: undefined }}
					/>
				</div>
			</Show>
		</div>
	);
}
