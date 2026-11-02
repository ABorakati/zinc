// Form controls: Button, TextInput, Select, Checkbox, Switch, Tabs (shadcn look, the web UI's ui/button.tsx, input.tsx,
// checkbox.tsx; Switch and Tabs follow the Toolbar's view toggle). Colours come from the tokens in theme.ts.
import { createSignal, For, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import type { Style } from "../contracts";
import { Icon } from "../icons";
import { shadows, tw, type BoxShadow } from "../theme";
import { boundsOf, mode, t, tok, tx, type MenuItem } from "./core";
import { openMenu } from "./menu";

// ---------------------------------------------------------------------------------------------------- Button

const BUTTON_SIZE = {
	sm: { box: "h-7 gap-1.5 px-2.5", text: "text-xs font-medium", icon: 14 },
	md: { box: "h-9 gap-1.5 px-3.5", text: "text-[13px] font-medium", icon: 14 },
	icon: { box: "size-8", text: "text-[13px] font-medium", icon: 16 },
} as const;
/** Box classes and the name of the text colour token. `default` is the neutral (secondary) button, `primary` the accent one. */
const BUTTON_VARIANT = {
	default: { box: "bg-secondary hover:bg-secondary/80", fg: "secondary-foreground" },
	primary: { box: "bg-primary hover:bg-primary/90", fg: "primary-foreground" },
	ghost: { box: "hover:bg-accent", fg: "foreground" },
	outline: { box: "border border-input hover:bg-accent", fg: "foreground" },
	destructive: { box: "bg-destructive hover:bg-destructive/90", fg: "destructive-foreground" },
} as const;

export function Button(p: { children?: JSX.Element; onClick?: () => void; variant?: "default" | "primary" | "ghost" | "outline" | "destructive"; size?: "sm" | "md" | "icon"; disabled?: boolean; icon?: string; style?: Style }): JSX.Element {
	const size = () => BUTTON_SIZE[p.size ?? "md"];
	const variant = () => BUTTON_VARIANT[p.variant ?? "default"];
	const fg = () => tok(variant().fg);
	const isText = () => typeof p.children === "string" || typeof p.children === "number";
	return (
		<div
			onClick={() => { if (!p.disabled) p.onClick?.(); }}
			style={{
				...t(`flex flex-none items-center justify-center rounded-md ${size().box} ${variant().box}`),
				cursor: p.disabled ? "default" : "pointer",
				opacity: p.disabled ? 0.5 : 1,
				...(p.disabled ? { hover: {} } : {}),
				...(p.variant === "primary" && p.size !== "icon" ? { boxShadow: shadows[mode()].primary } : {}),
				...p.style,
			}}
		>
			{p.icon ? <Icon name={p.icon} size={size().icon} color={fg()} style={{ marginRight: p.children !== undefined && p.size !== "icon" ? 6 : 0 }} /> : undefined}
			<Show when={isText()} fallback={p.children}>
				<text style={{ ...tx(size().text), color: fg(), whiteSpace: "nowrap" }}>{String(p.children)}</text>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- TextInput

const inputTheme = () => ({
	appearance: mode(),
	bg: tok("background"), // the editor paints its own surface; inputs sit on bg-background surfaces (dialogs, cards)
	text: tok("foreground"),
	textMuted: tok("muted-foreground"),
	textFaint: tok("muted-foreground"),
	textDim: tok("muted-foreground"),
	accent: tok("primary"),
	caret: tok("primary"),
	fontSans: "Inter",
});

/** ui/input.tsx: h-7 w-full rounded-md border border-input bg-transparent px-2 text-[13px] shadow-xs, focus: border-ring ring-2 ring-ring/30. */
export function TextInput(p: { value: string; onInput: (v: string) => void; placeholder?: string; multiline?: boolean; onEnter?: () => void; autofocus?: boolean; style?: Style }): JSX.Element {
	const [focused, setFocused] = createSignal(false);
	const frame = (): Style => ({
		...t(p.multiline ? "flex w-full min-w-0 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs" : "flex h-7 w-full min-w-0 items-center rounded-md border border-input bg-transparent px-2 shadow-xs"),
		...(p.multiline ? { minHeight: 64 } : {}),
		...(focused()
			? { borderColor: tok("ring"), boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color: tw("bg-ring/30", mode()).backgroundColor as string } satisfies BoxShadow] }
			: {}),
		...p.style,
	});
	const field: Style = { flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: "Inter", keyboardFocusDim: false };
	const value = (e: EventPayload) => (e as { value?: string }).value ?? "";
	return (
		<div style={frame()}>
			{p.multiline ? (
				<textarea
					value={p.value}
					placeholder={p.placeholder}
					minRows={3}
					autoFocus={p.autofocus}
					onChange={(e: EventPayload) => p.onInput(value(e))}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={(e) => { if (e.key === "enter" && (e.modifiers?.ctrl || e.modifiers?.cmd)) p.onEnter?.(); }}
					style={{ ...field, color: tok("foreground") }}
					theme={inputTheme()}
				/>
			) : (
				<input
					value={p.value}
					placeholder={p.placeholder}
					autoFocus={p.autofocus}
					onChange={(e: EventPayload) => p.onInput(value(e))}
					onSubmit={() => p.onEnter?.()}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					style={{ ...field, height: 26, color: tok("foreground") }}
					theme={inputTheme()}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- Select

/** A trigger styled like the input that opens a menu of the options (checked = current); `hint` shows muted on the right. */
export function Select<T extends string>(p: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; width?: number }): JSX.Element {
	let el: HostElement | undefined;
	const current = () => p.options.find((o) => o.value === p.value)?.label ?? "";
	const open = (e: EventPayload) => {
		const items: MenuItem[] = p.options.map((o) => ({ label: o.label, shortcut: o.hint, checked: o.value === p.value, onSelect: () => p.onChange(o.value) }));
		const b = boundsOf(el);
		openMenu(b ? { rect: b } : { x: e.x ?? 0, y: e.y ?? 0 }, items, { minWidth: p.width ?? b?.width });
	};
	return (
		<div
			ref={(x: HostElement) => { el = x; }}
			onClick={open}
			style={{
				...t("flex h-7 min-w-0 items-center justify-between rounded-md border border-input bg-transparent px-2 shadow-xs"),
				width: p.width ?? "100%",
				cursor: "pointer",
			}}
		>
			<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{current()}</text>
			<Icon name="chevrons-up-down" size={14} color={tok("muted-foreground")} style={{ marginLeft: 8 }} />
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- Checkbox / Switch

/** ui/checkbox.tsx: size-4 rounded-[4px] border border-input bg-background, checked: border-primary bg-primary + a white check. */
export function Checkbox(p: { checked: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
	return (
		<div onClick={() => p.onChange(!p.checked)} style={{ ...t("flex flex-none items-center"), cursor: "pointer", alignSelf: "flex-start" }}>
			<div
				style={{
					...t("flex size-4 flex-none items-center justify-center rounded-[4px] border"),
					borderColor: p.checked ? tok("primary") : tok("input"),
					backgroundColor: p.checked ? tok("primary") : tok("background"),
				}}
			>
				<Show when={p.checked}>
					<Icon name="check" size={12} strokeWidth={3} color={tok("primary-foreground")} />
				</Show>
			</div>
			<Show when={p.label}>
				<text style={{ ...tx("text-[13px] text-foreground"), marginLeft: 8 }}>{p.label ?? ""}</text>
			</Show>
		</div>
	);
}

/** shadcn switch: h-[18px] w-8 rounded-full, bg-input off / bg-primary on, 14px thumb. */
export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
	return (
		<div onClick={() => p.onChange(!p.checked)} style={{ ...t("flex flex-none items-center"), cursor: "pointer", alignSelf: "flex-start" }}>
			<div
				style={{
					...t("flex h-[18px] w-8 flex-none items-center rounded-full p-0.5"),
					backgroundColor: p.checked ? tok("primary") : tok("input"),
					justifyContent: p.checked ? "flex-end" : "flex-start",
				}}
			>
				<div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: "#ffffff", boxShadow: tw("shadow-sm", mode()).boxShadow as BoxShadow[] }} />
			</div>
			<Show when={p.label}>
				<text style={{ ...tx("text-[13px] text-foreground"), marginLeft: 8 }}>{p.label ?? ""}</text>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- Tabs

/** Segmented tabs: the Toolbar's view toggle ("flex rounded-lg bg-muted p-[3px]", active "bg-background shadow-sm"). */
export function Tabs<T extends string>(p: { value: T; tabs: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-none rounded-lg bg-muted p-[3px]"), alignSelf: "flex-start" }}>
			<For each={p.tabs}>{(tab) => {
				const on = () => p.value === tab.value;
				return (
					<div
						onClick={() => p.onChange(tab.value)}
						style={{
							...t("flex h-[30px] items-center rounded-md px-2.5"),
							cursor: "pointer",
							...(on() ? { backgroundColor: tok("background"), boxShadow: tw("shadow-sm", mode()).boxShadow as BoxShadow[] } : {}),
						}}
					>
						{tab.icon ? <Icon name={tab.icon} size={14} color={tok(on() ? "foreground" : "muted-foreground")} style={{ marginRight: 6 }} /> : undefined}
						<text style={{ ...tx(on() ? "text-[13px] font-medium text-foreground" : "text-[13px] text-muted-foreground"), whiteSpace: "nowrap" }}>{tab.label}</text>
					</div>
				);
			}}</For>
		</div>
	);
}
