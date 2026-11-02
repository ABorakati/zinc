// Small building blocks the feature dialogs and panels share, on top of src/ui (menus, dialogs, controls) and the theme.
// GPUIX facts honoured here: every <text> has a colour (Txt), one child per <text> (pass a template string), no display:none.
import { createSignal, Show, type JSX } from "solid-js";
import type { Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import { Button, openDialog, TextInput } from "../ui";

export const mode = (): Mode => store.mode();
export const t = (cls: string): Style => tw(cls, mode());
export const tx = (cls: string): Style => textStyle(cls, mode());
export const tok = (name: string): string => tokens[mode()][name] ?? "#888";

/** A text run: `class` is Tailwind (text-xs text-muted-foreground …); children is ONE string. */
export function Txt(p: { class?: string; style?: Style; children: string | undefined }): JSX.Element {
	return <text style={{ ...tx(p.class ?? ""), ...p.style }}>{p.children ?? ""}</text>;
}

/** Single-line truncated text that can shrink inside a row. */
export function Line(p: { class?: string; style?: Style; children: string | undefined }): JSX.Element {
	return <Txt class={p.class} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1, ...p.style }}>{p.children}</Txt>;
}

/** Wrapping paragraph. */
export function Para(p: { class?: string; style?: Style; children: string | undefined }): JSX.Element {
	return <Txt class={p.class} style={{ whiteSpace: "normal", ...p.style }}>{p.children}</Txt>;
}

export function Gap(p: { h?: number; w?: number }): JSX.Element {
	return <div style={{ height: p.h ?? 0, width: p.w ?? 0, flexShrink: 0 }} />;
}

/** `grid gap-1` label over a control, optional hint underneath. */
export function Field(p: { label: string; hint?: string; children: JSX.Element; style?: Style }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col gap-1"), minWidth: 0, ...p.style }}>
			<Txt class="text-xs font-medium text-foreground">{p.label}</Txt>
			{p.children}
			<Show when={p.hint}><Txt class="text-xs text-muted-foreground">{p.hint}</Txt></Show>
		</div>
	);
}

/** A scrollable region with a fixed height (GPUIX scrolls an overflow:scroll box with a definite size). */
export function Scroll(p: { height?: number | string; children: JSX.Element; style?: Style; border?: boolean }): JSX.Element {
	return (
		<div style={{ ...t(`flex flex-col min-h-0 overflow-y-auto ${p.border ? "rounded-md border" : ""}`), height: p.height, ...p.style }}>
			{p.children}
		</div>
	);
}

/** Clickable row with hover + selected tint. */
export function Row(p: { selected?: boolean; onClick?: () => void; children: JSX.Element; style?: Style; class?: string }): JSX.Element {
	return (
		<div
			onClick={() => p.onClick?.()}
			style={{ ...t(`flex items-center gap-2 px-2 py-1.5 ${p.selected ? "bg-accent" : "hover:bg-accent/60"} ${p.class ?? ""}`), cursor: p.onClick ? "pointer" : undefined, ...p.style }}
		>
			{p.children}
		</div>
	);
}

/** A small outlined tag ("author-date", "installed"). */
export function Chip(p: { children: string; tone?: "muted" | "success" | "warning" }): JSX.Element {
	const bg = () => (p.tone === "success" ? "bg-success" : p.tone === "warning" ? "bg-warning" : "bg-muted");
	const fg = () => (p.tone === "success" ? "text-success-foreground" : p.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground");
	return (
		<div style={t(`flex flex-none items-center rounded border px-1 ${bg()}`)}>
			<Txt class={`text-[10px] ${fg()}`}>{p.children}</Txt>
		</div>
	);
}

export function Progress(p: { value: number }): JSX.Element {
	return (
		<div style={{ ...t("overflow-hidden rounded-full bg-muted"), width: "100%", height: 4 }}>
			<div style={{ ...t("bg-primary rounded-full"), width: `${Math.max(0, Math.min(100, p.value * 100))}%`, height: 4 }} />
		</div>
	);
}

/** A single radio-style choice row. */
export function Choice(p: { selected: boolean; label: string; hint?: string; onClick: () => void }): JSX.Element {
	return (
		<Row selected={p.selected} onClick={p.onClick} style={{ borderRadius: 6 }}>
			<div style={{ ...t("flex flex-none items-center justify-center rounded-full border"), width: 14, height: 14, borderColor: p.selected ? tok("primary") : tok("input") }}>
				<Show when={p.selected}><div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tok("primary") }} /></Show>
			</div>
			<Txt class="text-sm font-medium text-foreground">{p.label}</Txt>
			<Show when={p.hint}><Line class="text-xs text-muted-foreground">{p.hint}</Line></Show>
		</Row>
	);
}

/** Dialog button row: `left` is pinned left, the children right. */
export function Footer(p: { children: JSX.Element; left?: JSX.Element }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-row items-center gap-2"), width: "100%", justifyContent: "space-between" }}>
			<div style={t("flex flex-row items-center gap-2")}>{p.left}</div>
			<div style={t("flex flex-row items-center justify-end gap-2")}>{p.children}</div>
		</div>
	);
}

export function ErrorLine(p: { children: string | undefined }): JSX.Element {
	return <Show when={p.children}><Txt class="text-xs text-destructive">{p.children}</Txt></Show>;
}

/** Static "busy" glyph (GPUIX has no CSS animation). */
export function Spinner(p: { size?: number }): JSX.Element {
	return <Icon name="loader-circle" size={p.size ?? 14} color={tok("primary")} />;
}

/** Small square icon button for panel headers. */
export function IconBtn(p: { icon: string; title?: string; onClick: () => void }): JSX.Element {
	return (
		<div onClick={() => p.onClick()} style={{ ...t("flex flex-none items-center justify-center rounded-md hover:bg-accent"), width: 24, height: 24, cursor: "pointer" }}>
			<Icon name={p.icon} size={14} color={tok("muted-foreground")} />
		</div>
	);
}

/** Floating status card (Retrieve Metadata bottom-left, Find Full Text bottom-right): header with title/progress + body. */
export function FloatingPanel(p: {
	side: "left" | "right";
	title: string;
	subtitle?: string;
	progress?: number; // 0..1 while running
	collapsed?: boolean;
	onToggle?: () => void;
	onClose?: () => void;
	actions?: JSX.Element;
	children: JSX.Element;
}): JSX.Element {
	return (
		<div style={{
			...t("flex flex-col overflow-hidden rounded-lg border bg-background"),
			position: "absolute", bottom: 12, [p.side]: 12, width: 352, maxHeight: 420,
			boxShadow: [{ offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: "rgba(0,0,0,0.28)" }],
		}}>
			<div style={t("flex flex-row items-center gap-2 px-3 py-2")}>
				<div style={{ ...t("flex flex-col gap-1"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
					<Line class="text-sm font-medium text-foreground">{p.subtitle ? `${p.title} · ${p.subtitle}` : p.title}</Line>
					<Show when={p.progress !== undefined}><Progress value={p.progress ?? 0} /></Show>
				</div>
				{p.actions}
				<Show when={p.onToggle}><IconBtn icon={p.collapsed ? "chevron-up" : "chevron-down"} onClick={() => p.onToggle!()} /></Show>
				<Show when={p.onClose}><IconBtn icon="x" onClick={() => p.onClose!()} /></Show>
			</div>
			<Show when={!p.collapsed}>
				<div style={{ ...t("flex flex-col border-t overflow-y-auto"), maxHeight: 340 }}>{p.children}</div>
			</Show>
		</div>
	);
}

/** Ask for a line of text; resolves undefined when cancelled. */
export function promptText(o: { title: string; description?: string; initial?: string; confirmLabel: string; placeholder?: string }): Promise<string | undefined> {
	return openDialog<string>((close) => {
		const [v, setV] = createSignal(o.initial ?? "");
		const ok = () => { const s = v().trim(); if (s) close(s); };
		return (
			<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
				<Show when={o.description}><Para class="text-sm text-muted-foreground">{o.description}</Para></Show>
				<TextInput value={v()} onInput={setV} onEnter={ok} autofocus placeholder={o.placeholder} />
				<Footer>
					<Button variant="outline" size="sm" onClick={() => close()}>Cancel</Button>
					<Button variant="primary" size="sm" disabled={!v().trim()} onClick={ok}>{o.confirmLabel}</Button>
				</Footer>
			</div>
		);
	}, { title: o.title, width: 400 });
}

/** One row of a settings section: label + description on the left, the control on the right. */
export function SettingRow(p: { label: string; description?: string; children: JSX.Element }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-row items-center gap-4 py-3 border-b"), width: "100%" }}>
			<div style={{ ...t("flex flex-col gap-0.5"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
				<Txt class="text-[13px] font-medium text-foreground">{p.label}</Txt>
				<Show when={p.description}><Para class="text-xs text-muted-foreground">{p.description}</Para></Show>
			</div>
			<div style={{ ...t("flex flex-row items-center gap-2"), flexShrink: 0 }}>{p.children}</div>
		</div>
	);
}
export const SettingsBody = (p: { children: JSX.Element }): JSX.Element => <div style={{ ...t("flex flex-col"), width: "100%" }}>{p.children}</div>;
