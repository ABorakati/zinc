// Controls and rows of the Settings page, on top of the shared primitives (../ui): segmented choice, switch, select, buttons,
// a text field that applies on Enter / Apply, a key cap, and the SettingRow every setting is drawn in.
import { createEffect, createSignal, Show, type JSX } from "solid-js";
import type { Style } from "../contracts";
import { Divider, Txt, t } from "../shell/kit";
import { Button, Select, Switch, Tabs, TextInput } from "../ui";

export interface Option<T extends string> { value: T; label: string; hint?: string }

/** Pill row of exclusive choices. */
export function Segmented<T extends string>(p: { value: T; options: Option<T>[]; onChange: (v: T) => void }): JSX.Element {
	return <Tabs<T> value={p.value} tabs={p.options.map((o) => ({ value: o.value, label: o.label }))} onChange={p.onChange} />;
}

export function Toggle(p: { checked: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
	return <Switch checked={p.checked} onChange={p.onChange} label={p.label} />;
}

export function Choice<T extends string>(p: { value: T; options: Option<T>[]; onChange: (v: T) => void; width?: number }): JSX.Element {
	return <Select<T> value={p.value} options={p.options} onChange={p.onChange} width={p.width} />;
}

/** The small outlined button used all over Settings. */
export function Btn(p: { children: JSX.Element; onClick: () => void; disabled?: boolean; primary?: boolean; icon?: string }): JSX.Element {
	return <Button variant={p.primary ? "primary" : "outline"} size="sm" disabled={p.disabled} icon={p.icon} onClick={p.onClick}>{p.children}</Button>;
}

/** Right-aligned muted value text. */
export function Value(p: { children: string; style?: Style; wrap?: boolean }): JSX.Element {
	return <Txt cls="text-xs text-muted-foreground" style={p.style} wrap={p.wrap}>{p.children}</Txt>;
}

/** A key cap: Ctrl+Shift+A. */
export function Kbd(p: { children: string }): JSX.Element {
	return (
		<div style={t("flex h-6 items-center rounded-md border border-border bg-muted px-2")}>
			<Txt cls="text-[11px] font-medium text-foreground" wrap={false}>{p.children}</Txt>
		</div>
	);
}

/**
 * A text input whose value is applied on Enter or the Apply button (not per key stroke: a half-typed font name or path would
 * otherwise be applied). `value` is the stored value; the field follows it when it changes elsewhere.
 */
export function TextField(p: { value: string; onCommit: (v: string) => void; placeholder?: string; width?: number; disabled?: boolean }): JSX.Element {
	const [draft, setDraft] = createSignal(p.value);
	createEffect(() => setDraft(p.value));
	const dirty = () => draft() !== p.value;
	const commit = () => { if (dirty() && !p.disabled) p.onCommit(draft()); };
	return (
		<div style={t("flex items-center gap-2")}>
			<TextInput value={draft()} onInput={setDraft} onEnter={commit} placeholder={p.placeholder} style={{ width: p.width ?? 240, opacity: p.disabled ? 0.5 : 1 }} />
			<Show when={dirty()}>
				<Btn onClick={commit}>Apply</Btn>
			</Show>
		</div>
	);
}

/**
 * One setting: label + description on the left, the control on the right ("inline"), or the control underneath ("block").
 * `unavailable` dims the row and shows a note instead of a control.
 */
export function SettingRow(p: {
	label: string;
	description?: string;
	layout?: "inline" | "block";
	unavailable?: boolean | string;
	control?: () => JSX.Element;
	last?: boolean;
	id?: string;
}): JSX.Element {
	const na = () => !!p.unavailable || !p.control;
	const block = () => p.layout === "block";
	return (
		<div style={{ ...t("flex flex-col"), width: "100%" }} aria-id={p.id}>
			<div style={{ ...t(block() ? "flex flex-col gap-2 py-3" : "flex items-center gap-6 py-3"), width: "100%" }}>
				<div style={{ ...t("flex flex-col gap-0.5"), minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: 0, opacity: na() ? 0.6 : 1 }}>
					<div style={t("flex flex-wrap items-center gap-2")}>
						<Txt cls="text-sm font-medium text-foreground">{p.label}</Txt>
						<Show when={na()}>
							<div style={t("flex items-center rounded-full border border-border px-1.5")}>
								<Txt cls="text-[10px] text-muted-foreground" wrap={false}>{typeof p.unavailable === "string" ? p.unavailable : "Not available yet"}</Txt>
							</div>
						</Show>
					</div>
					<Show when={p.description}>
						<Txt cls="text-xs text-muted-foreground">{p.description!}</Txt>
					</Show>
				</div>
				<Show when={!na()}>
					<div style={{ ...t("flex items-center"), flexShrink: 0, ...(block() ? { flexShrink: 1, minWidth: 0 } : { maxWidth: "55%", justifyContent: "flex-end" }) }}>{p.control!()}</div>
				</Show>
			</div>
			<Show when={!p.last}><Divider /></Show>
		</div>
	);
}
