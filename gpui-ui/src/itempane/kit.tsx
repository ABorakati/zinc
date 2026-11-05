// Small building blocks of the item pane (the GPUI counterpart of ui/src/itempane/ui.tsx): section frame, label/value rows,
// click-to-edit fields on native <input>/<textarea>, icon/text buttons and an autocomplete picker. Class strings are the web UI's.
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw, withAlpha } from "../theme";
import { useGpuix, type HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { openMenu, Tooltip, type MenuItem } from "../ui";
import { boundsOf, hideTooltip, showTooltip } from "../ui/core";
import { gatedHover } from "../cards/scrolling";

export const mode = (): Mode => store.mode();
export const tok = (name: string): string => tokens[mode()][name] ?? "#888";
export const t = (cls: string): Style => tw(cls, mode());
export const tx = (cls: string): Style => textStyle(cls, mode());

/** Truncate a <text> to one line with an ellipsis (inside a flex child with minWidth 0). */
export const TRUNC: Style = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 };

/** Theme object for native <input>/<textarea>: caret and selection follow the app colours. */
export function inputTheme(bg?: string) {
	return {
		appearance: mode(),
		bg: bg ?? tok("background"),
		text: tok("foreground"),
		textMuted: tok("muted-foreground"),
		textFaint: withAlpha(tok("muted-foreground"), 0.7),
		textDim: withAlpha(tok("muted-foreground"), 0.7),
		accent: tok("primary"),
		caret: tok("primary"),
		fontSans: "Inter",
	};
}

// ---- buttons ----

/** `size-5 rounded text-muted-foreground hover:bg-accent` icon button (IconBtn). */
export function IconBtn(p: { icon: string; title: string; onClick?: () => void; disabled?: boolean; size?: number; box?: number; color?: string }): JSX.Element {
	const box = () => p.box ?? 20;
	// the Tooltip component wraps its child in a div; inline handlers give the same delayed label with one node less per button
	let el: HostElement | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; hideTooltip(); };
	onCleanup(cancel);
	const enter = (e: EventPayload) => {
		cancel();
		const pointer = { x: e.x ?? 0, y: e.y ?? 0 };
		timer = setTimeout(() => { timer = undefined; showTooltip({ label: p.title, rect: boundsOf(el), pointer }); }, 500);
	};
	return (
		<div
			ref={(x: HostElement) => { el = x; }}
			role="button"
			aria-label={p.title}
			onClick={() => { if (!p.disabled) p.onClick?.(); }}
			onMouseEnter={enter}
			onMouseLeave={cancel}
			onMouseDown={cancel}
			style={{
				...t("flex flex-none items-center justify-center rounded"),
				width: box(), height: box(),
				cursor: p.disabled ? "default" : "pointer",
				opacity: p.disabled ? 0.3 : 1,
				hover: p.disabled ? {} : { backgroundColor: tok("accent") },
			}}
		>
			<Icon name={p.icon} size={p.size ?? 14} color={p.color ?? tok("muted-foreground")} />
		</div>
	);
}

/** `h-6 rounded-md border px-2 text-xs` text button (TextBtn). */
export function TextBtn(p: { label: string; icon?: string; onClick?: () => void; primary?: boolean; disabled?: boolean; title?: string }): JSX.Element {
	const fg = () => (p.primary ? tok("primary-foreground") : tok("foreground"));
	const body = (
		<div
			role="button"
			aria-label={p.title ?? p.label}
			onClick={() => { if (!p.disabled) p.onClick?.(); }}
			style={{
				...t("flex h-6 flex-none items-center gap-1 rounded-md border px-2"),
				borderColor: p.primary ? "transparent" : tok("border"),
				backgroundColor: p.primary ? tok("primary") : "transparent",
				cursor: p.disabled ? "default" : "pointer",
				opacity: p.disabled ? 0.4 : 1,
				hover: p.disabled ? {} : { backgroundColor: p.primary ? withAlpha(tok("primary"), 0.9) : tok("accent") },
			}}
		>
			<Show when={p.icon}><Icon name={p.icon!} size={14} color={fg()} /></Show>
			<text style={{ ...tx("text-xs"), color: fg(), whiteSpace: "nowrap" }}>{p.label}</text>
		</div>
	);
	return p.title ? <Tooltip label={p.title}>{body}</Tooltip> : body;
}

// ---- section frame ----

const [collapsed, setCollapsedSig] = createSignal<Record<string, boolean>>({});
export const isCollapsed = (id: string) => !!collapsed()[id];
export const setCollapsed = (id: string, v: boolean) => setCollapsedSig({ ...collapsed(), [id]: v });

/** Count chip next to a section title: `h-[18px] min-w-[22px] rounded-full bg-border-soft px-1.5 text-[11px] font-semibold`. */
export function CountBadge(p: { n: number }): JSX.Element {
	return (
		<div style={{ ...t("flex h-[18px] min-w-[22px] flex-none items-center justify-center rounded-full bg-border-soft px-1.5") }}>
			<text style={{ ...tx("text-[11px] font-semibold text-secondary-foreground"), whiteSpace: "nowrap" }}>{String(p.n)}</text>
		</div>
	);
}

/** A collapsible section: 36 px header (chevron, icon, UPPERCASE title, count, right-aligned actions) over the body. */
/** One item of the pane's virtual list: a section (or a piece of the Info section) and the section it belongs to (tab row, scroll-to). */
export interface Entry { id: string; section: string; render: () => JSX.Element }

type HeadProps = { id: string; title: string; icon: string; count?: number; actions?: JSX.Element; first?: boolean };

/** The section frame's top: border-t (not on the first section) and the clickable 36 px header row. */
export function SectionHead(p: HeadProps): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col w-full flex-none"), borderTopWidth: p.first ? 0 : 1, borderColor: tok("border-soft") }}>
			<HeadRow {...p} />
		</div>
	);
}

function HeadRow(p: HeadProps): JSX.Element {
	// The header keeps a faint tint at all times (so the sections read as bands); hovering darkens its chevron, icon and title
	// instead. GPUIX hover styles only restyle the hovered element itself, not its children, so the text colour follows a
	// signal — gated, so the item pane's virtual list makes no hover commits while it scrolls.
	const [hot, setHot] = createSignal(false);
	const hover = gatedHover(setHot);
	const fg = () => tok(hot() ? "foreground" : "muted-foreground");
	return (
		<div
			onMouseEnter={hover.enter}
			onMouseLeave={hover.leave}
			style={{ ...t("flex h-9 flex-none items-center gap-1.5 px-5"), cursor: "pointer", backgroundColor: withAlpha(tok("foreground"), 0.03) }}
			onClick={() => setCollapsed(p.id, !isCollapsed(p.id))}
		>
			<Icon name={isCollapsed(p.id) ? "chevron-right" : "chevron-down"} size={14} color={fg()} />
			<Icon name={p.icon} size={14} color={fg()} />
			<text style={{ ...tx("text-[11px] font-semibold"), color: fg(), whiteSpace: "nowrap" }}>{p.title.toUpperCase()}</text>
			<Show when={(p.count ?? 0) > 0}><CountBadge n={p.count!} /></Show>
			<div style={{ flexGrow: 1 }} />
			<div style={{ ...t("flex items-center gap-0.5") }} onClick={(e) => (e as { stopPropagation?: () => void }).stopPropagation?.()}>{p.actions}</div>
		</div>
	);
}

/** One block of a virtualised section's body: the body's `px-5` plus its `pt-0.5` (first block) / `pb-3.5` (last block). */
export function Block(p: { first?: boolean; last?: boolean; children: JSX.Element }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col w-full flex-none px-5"), paddingTop: p.first ? 2 : 0, paddingBottom: p.last ? 14 : 0 }}>{p.children}</div>
	);
}

export function Section(p: HeadProps & { children: JSX.Element }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col w-full flex-none"), borderTopWidth: p.first ? 0 : 1, borderColor: tok("border-soft") }}>
			<HeadRow {...p} />
			<Show when={!isCollapsed(p.id)}>
				<div style={{ ...t("flex flex-col w-full pt-0.5 pb-3.5 px-5") }}>{p.children}</div>
			</Show>
		</div>
	);
}

/** Muted one-line message inside a section ("No attachments"). */
export function Empty(p: { text: string; children?: JSX.Element }): JSX.Element {
	return (
		<div style={{ ...t("flex items-center gap-2 px-1.5 py-1") }}>
			<text style={{ ...tx("text-xs text-muted-foreground") }}>{p.text}</text>
			{p.children}
		</div>
	);
}

// ---- label/value row ----

/** Width of the label column (clamp(64px, 28cqw, 112px) of the pane content width), set by the pane from its measured width. */
const [labelW, setLabelW] = createSignal(100);
export { labelW, setLabelW };

export function Row(p: { label: string; icon?: string; children: JSX.Element; id?: string }): JSX.Element {
	const tight = () => p.label.length * 6.6 > labelW() - (p.icon ? 20 : 0);
	return (
		<div style={{ ...t("flex items-start gap-x-3 py-[2px] w-full"), }}>
			<div style={{ width: labelW(), flexShrink: 0, ...t("flex items-center gap-1.5"), paddingTop: 5 }}>
				<Show when={p.icon}><Icon name={p.icon!} size={14} color={tok("muted-foreground")} /></Show>
				<text style={{ ...tx("text-xs text-muted-foreground"), ...(tight() ? TRUNC : { whiteSpace: "nowrap" }) }}>{p.label}</text>
			</div>
			<div style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, flexBasis: 0 }}>{p.children}</div>
		</div>
	);
}

// ---- click-to-edit text ----

const FIELD_FONT = "Inter";

/** Visible box of an edit control: border-b at rest, ring while editing. */
function editBox(multi: boolean): Style {
	return {
		width: "100%", minWidth: 0, borderWidth: 1, borderColor: tok("ring"), borderRadius: 4, backgroundColor: tok("background"),
		paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontSize: 13, lineHeight: 18, fontFamily: FIELD_FONT, color: tok("foreground"),
		...(multi ? {} : { height: 26 }),
	};
}

/**
 * A text value that becomes an <input> (or <textarea>) on click and saves on Enter / blur (Ctrl+Enter for multiline); Escape cancels.
 * `cls` is the Tailwind text class string of the shown text.
 */
export function Field(p: {
	value: string;
	onSave: (v: string) => void;
	multiline?: boolean;
	/** multiline: Enter saves (Shift+Enter or Ctrl+Enter is not needed); for titles */
	submitOnEnter?: boolean;
	/** no resting underline */
	bare?: boolean;
	placeholder?: string;
	cls?: string;
	nowrap?: boolean;
	end?: JSX.Element;
	editStyle?: Style;
	/** layout overrides for both the resting box and the edit control (e.g. flexGrow / width when sharing a row) */
	rootStyle?: Style;
	onEditing?: (e: boolean) => void;
	/** open directly in the editor (rename) */
	startEditing?: boolean;
}): JSX.Element {
	const [editing, setEditingRaw] = createSignal(!!p.startEditing);
	const setEditing = (v: boolean) => { setEditingRaw(v); p.onEditing?.(v); };
	let draft = p.value;
	let cancelled = false;
	const start = () => { draft = p.value; cancelled = false; setEditing(true); };
	// startEditing may turn true after this row was built (the pane is a cached virtual list): open the editor then.
	createEffect(on(() => p.startEditing, (v) => { if (v && !editing()) start(); }));
	const commit = () => {
		if (!editing()) return;
		setEditing(false);
		if (cancelled) { cancelled = false; return; }
		if (draft !== p.value) p.onSave(draft);
	};
	const key = (e: { key?: string; modifiers?: { control?: boolean; cmd?: boolean; ctrl?: boolean } }) => {
		if (e.key === "escape") { cancelled = true; commit(); }
		else if (p.multiline && e.key === "enter" && (e.modifiers?.control || e.modifiers?.ctrl || e.modifiers?.cmd)) commit();
	};
	return (
		<Show
			when={editing()}
			fallback={
				<div
					role="textbox"
					onClick={start}
					style={{
						...t("flex items-start w-full min-w-0 px-1.5 py-[2px]"),
						minHeight: 24, overflow: "hidden", cursor: "text",
						borderBottomWidth: p.bare ? 0 : 1, borderColor: tok("border-soft"),
						hover: { backgroundColor: withAlpha(tok("muted"), 0.6) },
						...p.rootStyle,
					}}
				>
					<Show when={p.value || p.placeholder}><text
						style={{
							...tx(p.cls ?? "text-[13px] leading-[18px]"),
							...(p.value ? {} : { color: withAlpha(tok("muted-foreground"), 0.7) }),
							flexGrow: 1, flexShrink: 1, minWidth: 0,
							...(p.nowrap ? TRUNC : {}),
						}}
					>
						{p.value || p.placeholder}
					</text></Show>
					{p.end}
				</div>
			}
		>
			<Show
				when={p.multiline}
				fallback={
					<input
						autoFocus
						value={p.value}
						placeholder={p.placeholder}
						onChange={(e) => { draft = (e as { value?: string }).value ?? ""; }}
						onSubmit={commit}
						onBlur={commit}
						onKeyDown={(e) => key(e as never)}
						style={{ ...editBox(false), ...p.rootStyle, ...p.editStyle }}
						theme={inputTheme()}
					/>
				}
			>
				<textarea
					autoFocus
					value={p.value}
					placeholder={p.placeholder}
					minRows={2}
					maxRows={14}
					onSubmit={p.submitOnEnter ? commit : undefined}
					onChange={(e) => { draft = (e as { value?: string }).value ?? ""; }}
					onBlur={commit}
					onKeyDown={(e) => key(e as never)}
					style={{ ...editBox(true), ...p.rootStyle, ...p.editStyle }}
					theme={inputTheme()}
				/>
			</Show>
		</Show>
	);
}

/** An always-visible bordered input (date parts, picker). `onCommit` fires on Enter and blur. */
export function BoxInput(p: { value: string; placeholder?: string; width?: number | string; onCommit: (v: string) => void; onInput?: (v: string) => void; onKey?: (key: string) => void; autoFocus?: boolean; numeric?: boolean; style?: Style }): JSX.Element {
	let draft = p.value;
	let done = p.value;
	const commit = () => { if (draft !== done) { done = draft; p.onCommit(draft); } };
	return (
		<input
			autoFocus={p.autoFocus}
			value={p.value}
			placeholder={p.placeholder}
			onChange={(e) => {
				let v = (e as { value?: string }).value ?? "";
				if (p.numeric) v = v.replace(/\D/g, "");
				draft = v;
				p.onInput?.(v);
			}}
			onSubmit={commit}
			onBlur={commit}
			onKeyDown={(e) => p.onKey?.((e as { key?: string }).key ?? "")}
			style={{
				height: 26, width: p.width ?? "100%", minWidth: 0, flexShrink: 0, borderWidth: 1, borderColor: tok("input"), borderRadius: 6,
				paddingLeft: 6, paddingRight: 6, fontSize: 13, lineHeight: 18, fontFamily: FIELD_FONT, color: tok("foreground"), backgroundColor: tok("background"),
				...p.style,
			}}
			theme={inputTheme()}
		/>
	);
}

// ---- autocomplete picker ----

/**
 * Text input with a result list under it (inline, so it never overflows the pane). Arrow keys move the highlight, Enter picks it
 * (or submits the typed text through onSubmitText when nothing is highlighted); a click on a result picks it.
 */
export function Picker<T>(p: {
	placeholder: string;
	query: (q: string) => Promise<T[]> | T[];
	label: (item: T) => string;
	sub?: (item: T) => string | undefined;
	icon?: (item: T) => string;
	onPick: (item: T) => void;
	onSubmitText?: (q: string) => void;
	onClose?: () => void;
	autoFocus?: boolean;
	/** keep the list open after picking (tags) */
	keepOpen?: boolean;
	/** show the list as soon as the field has focus, before anything is typed */
	listOnFocus?: boolean;
}): JSX.Element {
	const [q, setQ] = createSignal("");
	const [results, setResults] = createSignal<T[]>([]);
	const [open, setOpen] = createSignal(false);
	const [hi, setHi] = createSignal(-1);
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => { clearTimeout(timer); clearTimeout(closeTimer); });

	const run = (text: string) => {
		const my = ++seq;
		Promise.resolve(p.query(text)).then(
			(r) => { if (my === seq) { setResults(r.slice(0, 8)); setHi(r.length && text ? 0 : -1); } },
			() => { if (my === seq) setResults([]); },
		);
	};
	createEffect(on(q, (text) => { clearTimeout(timer); if (open()) timer = setTimeout(() => run(text), 100); }, { defer: true }));

	const pick = (item: T) => {
		p.onPick(item);
		setQ("");
		if (p.keepOpen) run("");
		else setOpen(false);
	};
	const submit = () => {
		const r = results()[hi()];
		if (open() && r !== undefined) pick(r);
		else if (q().trim() && p.onSubmitText) { p.onSubmitText(q().trim()); setQ(""); }
	};
	const key = (k: string) => {
		const n = results().length;
		if (k === "down" || k === "arrowdown") { setOpen(true); setHi((hi() + 1) % Math.max(n, 1)); }
		else if (k === "up" || k === "arrowup") setHi((hi() - 1 + n) % Math.max(n, 1));
		else if (k === "escape") { setOpen(false); setQ(""); p.onClose?.(); }
	};
	return (
		<div style={{ ...t("flex flex-col w-full") }}>
			<input
				autoFocus={p.autoFocus}
				value={q()}
				placeholder={p.placeholder}
				onChange={(e) => { setQ((e as { value?: string }).value ?? ""); setOpen(true); }}
				onFocus={() => { clearTimeout(closeTimer); setOpen(true); if (p.listOnFocus || q()) run(q()); }}
				onBlur={() => { closeTimer = setTimeout(() => { setOpen(false); p.onClose?.(); }, 180); }}
				onSubmit={submit}
				onKeyDown={(e) => key((e as { key?: string }).key ?? "")}
				style={{
					height: 24, width: "100%", minWidth: 0, borderWidth: 1, borderColor: tok("input"), borderRadius: 6, paddingLeft: 8, paddingRight: 8,
					fontSize: 12, lineHeight: 16, fontFamily: FIELD_FONT, color: tok("foreground"), backgroundColor: "transparent",
				}}
				theme={inputTheme(tok("background"))}
			/>
			<Show when={open() && results().length > 0}>
				<div style={{ ...t("flex flex-col w-full rounded-md border py-0.5"), marginTop: 2, backgroundColor: tok("popover"), borderColor: tok("border"), overflow: "hidden" }}>
					<For each={results()}>
						{(r, i) => (
							<div
								role="option"
								onMouseDown={() => pick(r)}
								onMouseEnter={() => setHi(i())}
								style={{ ...t("flex items-center gap-1.5 px-2 py-1"), backgroundColor: i() === hi() ? tok("accent") : "transparent", cursor: "pointer" }}
							>
								<Show when={p.icon}><Icon name={p.icon!(r)} size={14} color={tok("muted-foreground")} /></Show>
								<text style={{ ...tx("text-xs"), color: i() === hi() ? tok("accent-foreground") : tok("popover-foreground"), ...TRUNC, flexShrink: 1 }}>{p.label(r)}</text>
								<Show when={p.sub?.(r)}><text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap", flexShrink: 0 }}>{p.sub!(r)!}</text></Show>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

/** Grey placeholder block (loading state). */
export function Skeleton(p: { w: number | string; h: number }): JSX.Element {
	return <div style={{ width: p.w, height: p.h, borderRadius: 4, backgroundColor: tok("muted") }} />;
}

/** Scroll the pane to a section (set by the pane; used by "+N creators" in the header). */
let goTo: (id: string) => void = () => {};
export const setGoTo = (f: (id: string) => void) => { goTo = f; };
export const goToSection = (id: string) => goTo(id);

/** Borderless select for label columns (creator type): muted text with a small chevron; opens the option menu under itself. */
export function MiniSelect<T extends string>(p: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; width?: number }): JSX.Element {
	const gp = useGpuix();
	let el: { id: number } | undefined;
	const current = () => p.options.find((o) => o.value === p.value)?.label ?? p.value;
	const open = (e: { x?: number; y?: number }) => {
		const items: MenuItem[] = p.options.map((o) => ({ label: o.label, checked: o.value === p.value, onSelect: () => p.onChange(o.value) }));
		const b = el ? gp?.renderer.getElementBounds?.(el.id) : null;
		openMenu(b ? { rect: b } : { x: e.x ?? 0, y: e.y ?? 0 }, items, { minWidth: Math.max(120, p.width ?? 0) });
	};
	return (
		<div
			ref={(x: unknown) => { el = x as never; }}
			role="combobox"
			onClick={(e) => open(e as never)}
			style={{ ...t("flex items-center gap-0.5 rounded"), width: p.width, minWidth: 0, height: 22, cursor: "pointer", hover: { backgroundColor: withAlpha(tok("muted"), 0.6) } }}
		>
			<text style={{ ...tx("text-xs text-muted-foreground"), ...TRUNC, flexShrink: 1 }}>{current()}</text>
			<Icon name="chevron-down" size={11} color={tok("muted-foreground")} />
		</div>
	);
}
