// The host side of the `ui` import (plugin-api/wit/ui.wit): what a plugin can ask Zinc to do. plugin-host/src/imports/ui.zinc.ts
// is a thin wrapper that calls these functions. Everything here runs in the Zinc process.
//
// Dialogs and prompts are re-entrant: `run-dialog` suspends the plugin's call while the dialog is open, and events from the dialog
// arrive through `ui-events.on-event` meanwhile (core README: a plugin may be entered again while it waits in an import).
import { createSignal, For, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { Icon } from "../../icons";
import { Button, Checkbox, openDialog, openMenu, TextInput, toast } from "../../ui";
import { boundsOf, dismissToast, mode, overlayLayers, t, tok, tx } from "../../ui/core";
import { getPluginSupervisor } from "../host";
import { overrides as colorOverrides, tokenColor } from "./colors";
import { ControllerView } from "./ControllerView";
import { allocInstance, lookupInstance, P, ViewController } from "./controller";
import { textOf } from "./l10n";
import { lastPointer, toMenuItems } from "./render/node";
import { webHosts } from "./render/special";
import { measureText } from "./measure";
import type { FormField, Modifiers, RenderResult, Tree, UiSupervisor, UiText } from "./types";

/** What a handler context gives (a subset of plugin-host `HandlerContext`). */
export interface HostCtx {
	pluginId: string;
	has(permission: string): boolean;
	callExport(iface: string, fn: string, args?: unknown[]): Promise<unknown>;
}

/** The errors a handler throws: the wrapper (ui.zinc.ts) turns them into `result::err`. */
export class UiHostError extends Error {
	constructor(
		readonly tag: "not-found" | "invalid-argument" | "permission-denied" | "limit-exceeded" | "unavailable" | "internal",
		message: string,
	) {
		super(message);
	}
}

const NO_MODS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

/** A supervisor-shaped adapter over the handler context (calls go through `ctx.callExport`), with `get` from the app's supervisor. */
function adapter(ctx: HostCtx): UiSupervisor {
	return {
		call: (_id, iface, fn, args) => ctx.callExport(iface, fn, args),
		get: (id) => getPluginSupervisor()?.get(id),
		on: (e, h) => getPluginSupervisor()?.on(e as "status", h) ?? (() => {}),
	};
}

// ---------------------------------------------------------------------------------------------------- views owned by instance

function ownView(ctx: HostCtx, instance: bigint) {
	const c = lookupInstance(instance);
	if (!c || c.pluginId !== ctx.pluginId) throw new UiHostError("not-found", `no UI instance ${instance}`);
	return c;
}

/** `ui.push`. */
export function push(ctx: HostCtx, instance: bigint, update: RenderResult): void {
	ownView(ctx, instance).push(update);
}
export function refresh(ctx: HostCtx, instance: bigint): void {
	void ownView(ctx, instance).refreshContext();
}
export function focus(ctx: HostCtx, instance: bigint, key: string): void {
	ownView(ctx, instance).focusKey(key);
}
export function scrollTo(ctx: HostCtx, instance: bigint, key: string, align: string): void {
	ownView(ctx, instance).scrollToKey(key, align);
}
export function formValues(ctx: HostCtx, instance: bigint): FormField[] {
	return ownView(ctx, instance).formValues();
}
export function webPostMessage(ctx: HostCtx, instance: bigint, key: string, message: string): void {
	ownView(ctx, instance);
	webHosts.get(`${instance}|${key}`)?.post(message);
}

// ---------------------------------------------------------------------------------------------------- dialogs

interface DialogButton {
	id: string;
	label: UiText;
	role: "accept" | "cancel" | "destructive" | "extra";
	disabled: boolean;
	closes: boolean;
	isDefault: boolean;
}
interface DialogSpec {
	title: UiText;
	icon?: unknown;
	content: Tree;
	buttons: DialogButton[];
	width?: number;
	height?: number;
	resizable: boolean;
	modal: boolean;
	dismissOnEscape: boolean;
}
interface DialogEntry {
	ctl: ViewController;
	close: (button?: string) => void;
	modal: boolean;
}
const dialogs = new Map<string, DialogEntry>();
const MODELESS_MAX = 3;

function checkLimits(ctx: HostCtx, spec: { modal: boolean }) {
	const mine = [...dialogs.values()].filter((d) => d.ctl.pluginId === ctx.pluginId);
	if (spec.modal && mine.some((d) => d.modal)) throw new UiHostError("limit-exceeded", "a plugin can have one modal dialog open at a time");
	if (!spec.modal && mine.filter((d) => !d.modal).length >= MODELESS_MAX) throw new UiHostError("limit-exceeded", `a plugin can have ${MODELESS_MAX} modeless dialogs open at a time`);
}

const ROLE_VARIANT = { accept: "primary", cancel: "outline", destructive: "destructive", extra: "default" } as const;

function DialogBody(p: { ctl: ViewController; spec: DialogSpec; close: (button?: string) => void }): JSX.Element {
	const buttons = () =>
		p.spec.buttons
			.map((b) => {
				const st = p.ctl.state.meta?.buttons.find((x) => x.id === b.id);
				return { ...b, disabled: st?.disabled ?? b.disabled, hidden: st?.hidden ?? false };
			})
			.filter((b) => !b.hidden);
	const press = (b: DialogButton) => {
		if (b.closes || b.role === "accept" || b.role === "cancel") return p.close(b.id);
		void p.ctl.fireRaw(b.id, "press");
	};
	const dflt = () => buttons().find((b) => b.isDefault && !b.disabled);
	p.ctl.onDefaultAction = () => {
		const d = dflt();
		if (d) press(d);
	};
	return (
		<div
			style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}
			onKeyDown={(e: EventPayload) => {
				if ((e.key ?? "").toLowerCase() === "enter" && dflt()) press(dflt()!);
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", maxHeight: (p.spec.height ?? 520) - 90, overflow: "scroll" }}>
				<ControllerView controller={p.ctl} />
			</div>
			<Show when={buttons().length > 0}>
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
					<For each={buttons()}>
						{(b) => (
							<Button variant={ROLE_VARIANT[b.role] ?? "default"} disabled={b.disabled} onClick={() => press(b)}>
								{textOf(b.label, p.ctl.pluginId)}
							</Button>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

/** Show a dialog and resolve with how it ended: the pressed button (undefined = dismissed) and the named inputs' values. */
async function showDialog(ctx: HostCtx, spec: DialogSpec, instance: bigint, onReady?: (entry: DialogEntry) => void) {
	const ctl = new ViewController(
		ctx.pluginId,
		adapter(ctx),
		{ view: "", surface: "dialog", params: {}, theme: mode(), width: spec.width, height: spec.height, locale: "en-US" },
		instance,
	);
	ctl.showInitial(spec.content);
	void ctl.mount();
	let closeFn: (v?: string | undefined) => void = () => {};
	const entry: DialogEntry = { ctl, close: (b) => closeFn(b), modal: spec.modal };
	dialogs.set(String(instance), entry);
	onReady?.(entry);
	const button = await openDialog<string>(
		(close) => {
			closeFn = (v) => close(v);
			return <DialogBody ctl={ctl} spec={spec} close={(b) => close(b)} />;
		},
		{ title: textOf(spec.title, ctx.pluginId), width: spec.width ?? 480, dismissable: spec.dismissOnEscape },
	);
	const values = ctl.formValues();
	dialogs.delete(String(instance));
	await ctl.unmount();
	return { button, values };
}

export async function runDialog(ctx: HostCtx, spec: DialogSpec): Promise<{ button: string | undefined; values: FormField[] }> {
	checkLimits(ctx, spec);
	return showDialog(ctx, spec, allocInstance());
}

export function openDialogNow(ctx: HostCtx, spec: DialogSpec): bigint {
	checkLimits(ctx, spec);
	const instance = allocInstance();
	void showDialog(ctx, spec, instance).then(async (o) => {
		// the plugin hears the outcome as `close` events: the button, then the form
		const base = { handler: "", kind: "close", modifiers: NO_MODS, rev: 0n };
		try {
			await ctx.callExport("ui-events", "on-event", [instance, { ...base, payload: o.button === undefined ? P.none : P.button(o.button) }]);
			if (o.values.length) await ctx.callExport("ui-events", "on-event", [instance, { ...base, payload: P.form(o.values) }]);
		} catch {
			/* the plugin is gone */
		}
	});
	return instance;
}

export function updateDialog(ctx: HostCtx, instance: bigint, update: RenderResult): void {
	const d = dialogs.get(String(instance));
	if (!d || d.ctl.pluginId !== ctx.pluginId) throw new UiHostError("not-found", `no dialog ${instance}`);
	d.ctl.apply(update);
}

export function closeDialog(ctx: HostCtx, instance: bigint, button: string | undefined): void {
	const d = dialogs.get(String(instance));
	if (!d || d.ctl.pluginId !== ctx.pluginId) return;
	d.close(button);
}

/** Close every dialog of a plugin (it stopped, or the plugin host restarted). */
export function closeDialogsOf(pluginId: string | undefined): void {
	for (const d of [...dialogs.values()]) if (!pluginId || d.ctl.pluginId === pluginId) d.close(undefined);
}

// ---------------------------------------------------------------------------------------------------- alert, confirm, prompt

const toneIcon = (tone: string) => ({ info: "info", success: "circle-check", warning: "triangle-alert", error: "circle-x", neutral: "info" })[tone] ?? "info";
const toneColor = (tone: string) => tok(tone === "error" ? "destructive" : tone === "success" ? "success-foreground" : tone === "warning" ? "warning-foreground" : "primary");

export async function alert(ctx: HostCtx, title: UiText, message: UiText, tone: string): Promise<void> {
	await openDialog<boolean>(
		(close) => (
			<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				<div style={{ display: "flex", flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
					<Icon name={toneIcon(tone)} size={18} color={toneColor(tone)} style={{ marginTop: 1 }} />
					<text style={{ ...tx("text-[13px] text-foreground"), flexShrink: 1, minWidth: 0 }}>{textOf(message, ctx.pluginId)}</text>
				</div>
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end" }}>
					<Button variant="primary" onClick={() => close(true)}>
						OK
					</Button>
				</div>
			</div>
		),
		{ title: textOf(title, ctx.pluginId), width: 440 },
	);
}

export async function confirm(
	ctx: HostCtx,
	spec: { title: UiText; message: UiText; acceptLabel?: UiText; cancelLabel?: UiText; destructive: boolean; checkboxLabel?: UiText },
): Promise<{ accepted: boolean; checkbox: boolean }> {
	const [checked, setChecked] = createSignal(false);
	const r = await openDialog<boolean>(
		(close) => (
			<div
				style={{ display: "flex", flexDirection: "column", gap: 12 }}
				onKeyDown={(e: EventPayload) => {
					if ((e.key ?? "").toLowerCase() === "enter") close(true);
				}}
			>
				<text style={{ ...tx("text-[13px] text-foreground"), minWidth: 0 }}>{textOf(spec.message, ctx.pluginId)}</text>
				<Show when={spec.checkboxLabel}>
					<Checkbox checked={checked()} onChange={setChecked} label={textOf(spec.checkboxLabel, ctx.pluginId)} />
				</Show>
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
					<Button variant="outline" onClick={() => close(false)}>
						{spec.cancelLabel ? textOf(spec.cancelLabel, ctx.pluginId) : "Cancel"}
					</Button>
					<Button variant={spec.destructive ? "destructive" : "primary"} onClick={() => close(true)}>
						{spec.acceptLabel ? textOf(spec.acceptLabel, ctx.pluginId) : "OK"}
					</Button>
				</div>
			</div>
		),
		{ title: textOf(spec.title, ctx.pluginId), width: 440 },
	);
	return { accepted: r === true, checkbox: checked() };
}

export async function prompt(
	ctx: HostCtx,
	spec: { title: UiText; message?: UiText; value: string; placeholder?: UiText; password: boolean },
): Promise<string | undefined> {
	const [value, setValue] = createSignal(spec.value);
	const r = await openDialog<{ ok: boolean }>(
		(close) => (
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<Show when={spec.message}>
					<text style={{ ...tx("text-[13px] text-foreground"), minWidth: 0 }}>{textOf(spec.message, ctx.pluginId)}</text>
				</Show>
				<TextInput value={value()} onInput={setValue} placeholder={spec.placeholder ? textOf(spec.placeholder, ctx.pluginId) : undefined} autofocus onEnter={() => close({ ok: true })} />
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
					<Button variant="outline" onClick={() => close({ ok: false })}>
						Cancel
					</Button>
					<Button variant="primary" onClick={() => close({ ok: true })}>
						OK
					</Button>
				</div>
			</div>
		),
		{ title: textOf(spec.title, ctx.pluginId), width: 440 },
	);
	return r?.ok ? value() : undefined;
}

// ---------------------------------------------------------------------------------------------------- windows

/**
 * Zinc has one GPUIX window: it cannot open a second operating-system window yet. A plugin that needs one gets the WIT error and
 * can fall back to `ui.run-dialog` (or `extend.open-tab`).
 */
export function openWindow(ctx: HostCtx, _spec: unknown): never {
	if (!ctx.has("ui.windows")) throw new UiHostError("permission-denied", "ui.windows");
	throw new UiHostError("unavailable", "ui.open-window: Zinc cannot open a second window yet; use ui.run-dialog or extend.open-tab");
}
export function closeWindow(_ctx: HostCtx, _instance: bigint): void {}

// ---------------------------------------------------------------------------------------------------- popup menu

export async function popupMenu(
	ctx: HostCtx,
	at: { tag: "pointer" } | { tag: "node"; val: { instance: bigint; key: string } } | { tag: "point"; val: { x: number; y: number } },
	menu: Parameters<typeof toMenuItems>[0],
): Promise<string | undefined> {
	let anchor: { x: number; y: number } | { rect: { x: number; y: number; width: number; height: number } } = { x: lastPointer.x, y: lastPointer.y };
	if (at.tag === "point") anchor = { x: at.val.x, y: at.val.y };
	if (at.tag === "node") {
		const c = ownView(ctx, at.val.instance);
		const el = c.els.get("k:" + at.val.key) as { id: number } | undefined;
		const b = el ? boundsOf(el as never) : null;
		if (b) anchor = { rect: b };
	}
	return new Promise<string | undefined>((resolve) => {
		let chosen: string | undefined;
		openMenu(anchor, toMenuItems(menu, (x) => textOf(x, ctx.pluginId), (id) => (chosen = id)));
		const id = overlayLayers().at(-1)?.id;
		// the menu layer closes before onSelect runs: resolve a tick later, once the choice is known
		const poll = setInterval(() => {
			if (overlayLayers().some((l) => l.id === id)) return;
			clearInterval(poll);
			setTimeout(() => resolve(chosen), 0);
		}, 40);
	});
}

// ---------------------------------------------------------------------------------------------------- toasts

interface ToastSpec {
	title?: UiText;
	lines: { text: UiText; progress?: number; tone: string }[];
	tone: string;
	durationMs?: number;
	actions: { id: string; label: UiText }[];
}
const toasts = new Map<string, { pluginId: string; zid: string }>();

function showToastNow(ctx: HostCtx, instance: bigint, spec: ToastSpec) {
	const zid = `wp-${ctx.pluginId}-${instance}`;
	toasts.set(String(instance), { pluginId: ctx.pluginId, zid });
	const lines = spec.lines.map((l) => textOf(l.text, ctx.pluginId) + (l.progress !== undefined ? `  ${Math.round(l.progress * 100)}%` : ""));
	const title = spec.title ? textOf(spec.title, ctx.pluginId) : (lines.shift() ?? "");
	const press = (id: string) =>
		void ctx
			.callExport("ui-events", "on-event", [instance, { handler: id, kind: "press", modifiers: NO_MODS, payload: P.none, rev: 0n }])
			.catch(() => {});
	toast(title, {
		id: zid,
		kind: spec.tone === "error" ? "error" : spec.tone === "success" ? "success" : "info",
		description: lines.length ? lines.join("\n") : undefined,
		actions: spec.actions.map((a) => ({ label: textOf(a.label, ctx.pluginId), run: () => press(a.id) })),
		durationMs: spec.durationMs ?? 0, // none: stays until closed
	});
}

export function showToast(ctx: HostCtx, spec: ToastSpec): bigint {
	const instance = allocInstance();
	showToastNow(ctx, instance, spec);
	return instance;
}
export function updateToast(ctx: HostCtx, instance: bigint, spec: ToastSpec): void {
	if (toasts.get(String(instance))?.pluginId !== ctx.pluginId) throw new UiHostError("not-found", `no toast ${instance}`);
	showToastNow(ctx, instance, spec);
}
export function closeToast(ctx: HostCtx, instance: bigint): void {
	const t_ = toasts.get(String(instance));
	if (!t_ || t_.pluginId !== ctx.pluginId) return;
	toasts.delete(String(instance));
	dismissToast(t_.zid);
}

// ---------------------------------------------------------------------------------------------------- theme

const TOKENS = [
	"background", "foreground", "card", "muted", "muted-foreground", "popover", "popover-foreground", "border", "input", "ring",
	"primary", "primary-foreground", "primary-soft", "primary-tint", "primary-line", "primary-deep",
	"secondary", "secondary-foreground", "accent", "accent-foreground",
	"destructive", "destructive-foreground", "success", "success-foreground", "warning", "warning-foreground", "error", "error-foreground",
	"palette-blue", "palette-sky", "palette-green", "palette-amber", "palette-rust", "palette-rose", "palette-violet", "palette-slate",
]; // prettier-ignore

/** "#rrggbb" or "rgba(r, g, b, a)" -> 0xRRGGBBAA. */
export function cssToRgba(css: string): number {
	const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css);
	if (hex) return parseInt(hex[1]! + (hex[2] ?? "ff"), 16) >>> 0;
	const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(css);
	if (m) return (((+m[1]! & 255) << 24) | ((+m[2]! & 255) << 16) | ((+m[3]! & 255) << 8) | Math.round((m[4] === undefined ? 1 : +m[4]) * 255)) >>> 0;
	return 0x888888ff;
}

export function getTheme(): Record<string, unknown> {
	const m = mode();
	return {
		mode: m,
		colors: TOKENS.map((k) => [k, cssToRgba(tokenColor(k, m))] as [string, number]),
		fontSans: "Inter",
		fontTitle: "Source Serif 4",
		fontMono: "Cascadia Mono",
		baseFontSize: 13,
		scale: 1,
		reducedMotion: false,
		locale: Intl.DateTimeFormat().resolvedOptions().locale || "en-US",
		rtl: false,
	};
}

/** Per plugin, in the order they were set: the last one wins per token. */
const themeOverrides = new Map<string, { label: UiText; light: { token: string; color: number }[]; dark: { token: string; color: number }[] }>();
const listeners = new Set<() => void>();
/** Settings can list the overrides and switch them off (not built yet). */
export const themeOverrideList = () => [...themeOverrides].map(([pluginId, o]) => ({ pluginId, label: textOf(o.label, pluginId) }));
export const onThemeOverrideChange = (fn: () => void): (() => void) => (listeners.add(fn), () => listeners.delete(fn));

function recomputeOverrides() {
	for (const m of ["light", "dark"] as const) {
		const next: Record<string, string> = {};
		for (const o of themeOverrides.values()) for (const e of o[m]) next[e.token] = cssFromRgba(e.color);
		for (const k of Object.keys(colorOverrides[m])) delete colorOverrides[m][k];
		Object.assign(colorOverrides[m], next);
	}
	for (const fn of listeners) fn();
}
function cssFromRgba(v: number): string {
	const n = v >>> 0;
	const a = n & 255;
	const h = (x: number) => x.toString(16).padStart(2, "0");
	return a === 255 ? `#${h((n >>> 24) & 255)}${h((n >>> 16) & 255)}${h((n >>> 8) & 255)}` : `rgba(${(n >>> 24) & 255}, ${(n >>> 16) & 255}, ${(n >>> 8) & 255}, ${+(a / 255).toFixed(3)})`;
}

export function setThemeOverride(ctx: HostCtx, o: { label: UiText; light: { token: string; color: number }[]; dark: { token: string; color: number }[] }): void {
	if (!ctx.has("ui.theme")) throw new UiHostError("permission-denied", "ui.theme");
	themeOverrides.delete(ctx.pluginId); // re-setting moves it to the end: the last one set wins
	themeOverrides.set(ctx.pluginId, o);
	recomputeOverrides();
}
export function clearThemeOverride(ctx: HostCtx): void {
	if (themeOverrides.delete(ctx.pluginId)) recomputeOverrides();
}

export function measure(requests: { text: string; size: string; weight: string; family: string; maxWidth?: number }[]) {
	return requests.map(measureText);
}

