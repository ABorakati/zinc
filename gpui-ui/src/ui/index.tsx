// UI building blocks shared by every feature (the GPUI counterpart of ui/src/components/ui/* — Kobalte/shadcn there).
// CONTRACT: these signatures are fixed; the primitives owner replaces the placeholder bodies below with real ones.
// Overlays (menus, dialogs, toasts, tooltips) render into <OverlayHost/>, mounted once at the root of App.
import type { JSX } from "solid-js";
import type { Style } from "../contracts";

export interface MenuItem {
	label?: string;
	icon?: string; // lucide name
	shortcut?: string;
	disabled?: boolean;
	danger?: boolean;
	checked?: boolean; // shows a check mark (radio/checkbox items)
	separator?: true; // a divider line (other fields ignored)
	heading?: string; // a small non-clickable group label
	submenu?: MenuItem[];
	onSelect?: () => void;
}
/** Screen position in window (logical px), e.g. from a pointer event, or the rect of an element to align to. */
export type Anchor = { x: number; y: number } | { rect: { x: number; y: number; width: number; height: number }; align?: "start" | "end" };

/** Open a menu at a point or under a rect; closes on select, Escape or outside click. */
export function openMenu(_at: Anchor, _items: MenuItem[] | (() => MenuItem[])): void {}
/** A button that opens a dropdown menu under itself (trigger is any element). */
export function DropdownMenu(p: { trigger: JSX.Element; items: MenuItem[] | (() => MenuItem[]); align?: "start" | "end"; width?: number; style?: Style }): JSX.Element {
	return p.trigger;
}
/** Attach a right-click menu to its children. */
export function ContextMenu(p: { items: () => MenuItem[]; children: JSX.Element }): JSX.Element {
	return p.children;
}

/** A modal dialog; resolves with the value passed to close(). */
export function openDialog<T = void>(_render: (close: (v?: T) => void) => JSX.Element, _opts?: { title?: string; width?: number; dismissable?: boolean }): Promise<T | undefined> {
	return Promise.resolve(undefined);
}
/** Confirmation dialog (alert-dialog). */
export function confirm(_o: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
	return Promise.resolve(false);
}
/** Toast messages (solid-sonner in the web UI). */
export function toast(_message: string, _o?: { kind?: "info" | "success" | "error"; description?: string; action?: { label: string; run: () => void }; durationMs?: number }): void {}
/** Anchored popover (hover-card / popover in the web UI). */
export function Popover(p: { open: boolean; onClose: () => void; anchor: Anchor; children: JSX.Element; width?: number }): JSX.Element {
	return <div style={{ display: p.open ? "flex" : "none" }}>{p.children}</div>;
}
export function Tooltip(p: { label: string; children: JSX.Element }): JSX.Element {
	return p.children;
}

// ---- controls (shadcn look) ----
export function Button(p: { children: JSX.Element; onClick?: () => void; variant?: "default" | "primary" | "ghost" | "outline" | "destructive"; size?: "sm" | "md" | "icon"; disabled?: boolean; icon?: string; style?: Style }): JSX.Element {
	return <div onClick={() => p.onClick?.()}>{p.children}</div>;
}
export function TextInput(p: { value: string; onInput: (v: string) => void; placeholder?: string; multiline?: boolean; onEnter?: () => void; autofocus?: boolean; style?: Style }): JSX.Element {
	return <input value={p.value} />;
}
export function Select<T extends string>(p: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; width?: number }): JSX.Element {
	return <div />;
}
export function Checkbox(p: { checked: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
	return <div />;
}
export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
	return <div />;
}
export function Tabs<T extends string>(p: { value: T; tabs: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void }): JSX.Element {
	return <div />;
}
/** Horizontal resizable panels (corvu/resizable in the web UI); sizes are fractions summing to 1, persisted by the caller. */
export function Resizable(p: { sizes: number[]; onSizes: (s: number[]) => void; minSizes?: number[]; children: JSX.Element[] }): JSX.Element {
	return <div style={{ display: "flex", flexDirection: "row" }}>{p.children}</div>;
}

/** Mount once at the root of App: renders open menus, dialogs, popovers, toasts and tooltips above everything. */
export function OverlayHost(): JSX.Element {
	return <div />;
}
