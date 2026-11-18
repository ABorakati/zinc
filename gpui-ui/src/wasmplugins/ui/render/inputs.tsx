// Input kinds: button, checkbox, switch, radio-group, select, text-input, number-input, slider, color-input, date-input,
// token-input, form. Values are kept by the host (what the user typed); a value from the plugin is applied only when it differs from
// the one it sent last (the store reconciles, so the effect on `spec().value` fires only then). `pref` binds a value to a plugin pref.
import { createEffect, createSignal, For, on, onCleanup, Show, untrack, useContext } from "solid-js";
import type { EventPayload, HostElement } from "@gpuix/solid";
import { Icon } from "../../../icons";
import { Button, Checkbox as ZCheckbox, openMenu, Switch as ZSwitch, type MenuItem } from "../../../ui";
import { boundsOf, t, tok, tx } from "../../../ui/core";
import { focusRing } from "../../../ui/controls";
import { withAlpha } from "../../../theme";
import { P } from "../controller";
import { hexToRgba } from "../convert";
import { rgbaCss } from "../colors";
import { usePref } from "../prefs";
import type { Suggestion } from "../types";
import { FormCtx, useRt, type KindComponent, type KindProps } from "./ctx";
import { UiIcon } from "./icons";
import { Children, domKey, modsOf, toMenuItems } from "./node";

const inputTheme = (rt: ReturnType<typeof useRt>) => ({
	appearance: rt.mode(),
	bg: tok("background"),
	text: tok("foreground"),
	textMuted: tok("muted-foreground"),
	textFaint: tok("muted-foreground"),
	textDim: tok("muted-foreground"),
	accent: tok("primary"),
	caret: tok("primary"),
	fontSans: "Inter",
});

/** Local state that follows the plugin's value when (and only when) the plugin sends a new one, and is bound to a pref if asked. */
function useHostValue<T>(p: KindProps, get: () => T, fromPref?: (v: any) => T | undefined, toPref?: (v: T) => any) {
	const rt = useRt();
	const [value, setValue] = createSignal<T>(untrack(get));
	createEffect(
		on(
			get,
			(v) => {
				setValue(() => v);
			},
			{ defer: true },
		),
	);
	const key = p.node.props.pref;
	if (key) {
		const [pref, writePref] = usePref(rt.pluginId, key);
		createEffect(() => {
			const v = pref();
			const x = v === undefined || !fromPref ? undefined : fromPref(v);
			if (x !== undefined) setValue(() => x);
		});
		return [value, (v: T) => (setValue(() => v), toPref && writePref(toPref(v)))] as const;
	}
	return [value, (v: T) => setValue(() => v)] as const;
}

/** Register a named control's current value with the view (and its form) so `form-values` and `submit` can report it. */
function useField(p: KindProps, tag: "text" | "number" | "flag" | "texts" | "color", val: () => unknown) {
	const rt = useRt();
	const form = useContext(FormCtx);
	createEffect(() => {
		const name = p.node.props.name;
		if (name) rt.ctl.setField(name, { tag, val: val() } as never, form?.id);
	});
}

const disabled = (p: KindProps) => p.node.props.disabled;
const noClick = (h: Record<string, unknown>) => {
	const { onClick: _c, ...rest } = h;
	return rest;
};
const stop = (e: EventPayload) => (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();

// ---------------------------------------------------------------------------------------------------- button

const LOOK: Record<string, { variant: "default" | "primary" | "ghost" | "outline" | "destructive"; fg: string }> = {
	standard: { variant: "default", fg: "secondary-foreground" },
	primary: { variant: "primary", fg: "primary-foreground" },
	ghost: { variant: "ghost", fg: "foreground" },
	outline: { variant: "outline", fg: "foreground" },
	destructive: { variant: "destructive", fg: "destructive-foreground" },
	link: { variant: "ghost", fg: "primary" },
};

const ButtonK: KindComponent = (p) => {
	const rt = useRt();
	const form = useContext(FormCtx);
	const spec = () => p.node.kind.val ?? {};
	let el: HostElement | undefined;
	const look = () => LOOK[spec().look ?? "standard"] ?? LOOK.standard!;
	const label = () => rt.txt(spec().label);
	const iconOnly = () => !label() && !!spec().icon;
	const isDisabled = () => disabled(p) || !!spec().loading || (!!spec().submit && !!form?.busy());
	const openMenuAt = (e?: EventPayload) => {
		const m = spec().menu;
		if (!m) return;
		const b = boundsOf(el);
		openMenu(b ? { rect: b } : { x: e?.x ?? 0, y: e?.y ?? 0 }, toMenuItems(m, rt.txt, (id) => void rt.ctl.fireRaw(id, "press", P.none, p.node.props.key)));
	};
	const press = () => {
		if (isDisabled()) return;
		if (spec().menu && spec().menuMode !== "split") return openMenuAt();
		rt.ctl.fire(p.node, "press", P.pointer(0, 0));
		if (spec().submit) form?.submit();
	};
	const pressedStyle = () => (spec().pressed ? { backgroundColor: tok("accent"), borderColor: tok("input"), borderWidth: 1 } : {});
	return (
		<div
			{...noClick(p.handlers)}
			ref={(x: HostElement) => {
				el = x;
				p.reg(x);
			}}
			style={{ display: "flex", flexDirection: "row", flexShrink: 0, alignSelf: "flex-start", ...p.box() }}
		>
			<Button
				variant={look().variant}
				size={iconOnly() ? "icon" : spec().size === "sm" ? "sm" : "md"}
				disabled={isDisabled()}
				icon={spec().loading ? "loader-circle" : spec().icon?.tag === "builtin" ? spec().icon.val : undefined}
				onClick={press}
				style={{ ...pressedStyle(), ...(spec().look === "link" ? { backgroundColor: "transparent" } : {}) }}
			>
				<Show when={spec().icon && spec().icon.tag !== "builtin" && !spec().loading}>
					<UiIcon icon={spec().icon} size={14} color={tok(look().fg)} />
				</Show>
				<Show when={label()}>
					<text
						style={{
							...tx(spec().size === "sm" ? "text-xs font-medium" : "text-[13px] font-medium"),
							color: tok(look().fg),
							whiteSpace: "nowrap",
							marginLeft: spec().icon ? 6 : 0,
							textDecoration: spec().look === "link" ? "underline" : "none",
						}}
					>
						{label()}
					</text>
				</Show>
			</Button>
			<Show when={spec().menu && spec().menuMode === "split"}>
				<div
					onClick={(e: EventPayload) => openMenuAt(e)}
					style={{ ...t("flex items-center justify-center rounded-md border px-1.5"), marginLeft: 2, height: spec().size === "sm" ? 28 : 36, cursor: "pointer", hover: { backgroundColor: tok("accent") } }}
				>
					<Icon name="chevron-down" size={14} color={tok("foreground")} />
				</div>
			</Show>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- checkbox, switch, radio

const CheckboxK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [on, setOn] = useHostValue(p, () => !!spec().checked, (v) => (v.tag === "flag" ? v.val : undefined), (v) => ({ tag: "flag", val: v }));
	useField(p, "flag", on);
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", alignSelf: "flex-start", opacity: disabled(p) ? 0.5 : 1, ...p.box() }}>
			<ZCheckbox
				checked={on()}
				label={rt.txt(spec().label)}
				onChange={(v) => {
					if (disabled(p)) return;
					setOn(v);
					rt.ctl.fire(p.node, "change", P.toggled(v));
				}}
			/>
		</div>
	);
};

const SwitchK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [on, setOn] = useHostValue(p, () => !!spec().on, (v) => (v.tag === "flag" ? v.val : undefined), (v) => ({ tag: "flag", val: v }));
	useField(p, "flag", on);
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", alignSelf: "flex-start", opacity: disabled(p) ? 0.5 : 1, ...p.box() }}>
			<ZSwitch
				checked={on()}
				label={rt.txt(spec().label)}
				onChange={(v) => {
					if (disabled(p)) return;
					setOn(v);
					rt.ctl.fire(p.node, "change", P.toggled(v));
				}}
			/>
		</div>
	);
};

const RadioGroupK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [val, setVal] = useHostValue<string | undefined>(p, () => spec().value, (v) => (v.tag === "text" ? v.val : undefined), (v) => ({ tag: "text", val: v ?? "" }));
	useField(p, "text", () => val() ?? "");
	const horizontal = () => spec().orientation === "horizontal";
	return (
		<div {...noClick(p.handlers)} role="radiogroup" style={{ display: "flex", flexDirection: horizontal() ? "row" : "column", gap: horizontal() ? 14 : 6, ...p.box() }}>
			<For each={(spec().options as any[]) ?? []}>
				{(o) => {
					const on = () => val() === o.value;
					const off = () => disabled(p) || o.disabled;
					return (
						<div
							role="radio"
							aria-checked={on()}
							tabIndex={off() ? undefined : 0}
							onClick={() => {
								if (off()) return;
								setVal(o.value);
								rt.ctl.fire(p.node, "change", P.text(o.value));
							}}
							style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 8, cursor: off() ? "default" : "pointer", opacity: off() ? 0.5 : 1, keyboardFocusDim: false, ...focusRing() }}
						>
							<div style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: on() ? tok("primary") : tok("input"), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: tok("background") }}>
								<Show when={on()}>
									<div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tok("primary") }} />
								</Show>
							</div>
							<div style={{ display: "flex", flexDirection: "column" }}>
								<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap" }}>{rt.txt(o.label)}</text>
								<Show when={o.description}>
									<text style={tx("text-xs text-muted-foreground")}>{rt.txt(o.description)}</text>
								</Show>
							</div>
						</div>
					);
				}}
			</For>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- select

const SelectK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	let el: HostElement | undefined;
	const multiple = () => !!spec().multiple;
	const [val, setVal] = useHostValue<string | undefined>(p, () => spec().value, (v) => (v.tag === "text" ? v.val : undefined), (v) => ({ tag: "text", val: v ?? "" }));
	const [vals, setVals] = createSignal<string[]>(untrack(() => spec().values ?? []));
	createEffect(on(() => JSON.stringify(spec().values), () => setVals(spec().values ?? []), { defer: true }));
	useField(p, untrack(multiple) ? "texts" : "text", () => (multiple() ? vals() : (val() ?? "")));
	const options = () => (spec().options as any[]) ?? [];
	const label = () => {
		if (multiple()) {
			const n = vals().length;
			return n === 0 ? "" : n === 1 ? rt.txt(options().find((o) => o.value === vals()[0])?.label) : `${n} selected`;
		}
		return rt.txt(options().find((o) => o.value === val())?.label);
	};
	const open = (e?: EventPayload) => {
		if (disabled(p)) return;
		const items: MenuItem[] = [];
		let group: string | undefined;
		for (const o of options()) {
			const g = o.group ? rt.txt(o.group) : undefined;
			if (g !== group && g) items.push({ heading: g });
			group = g;
			const checked = multiple() ? vals().includes(o.value) : val() === o.value;
			items.push({
				label: rt.txt(o.label),
				shortcut: o.description ? rt.txt(o.description) : undefined,
				icon: o.icon?.tag === "builtin" ? o.icon.val : undefined,
				disabled: o.disabled,
				checked,
				onSelect: () => {
					if (multiple()) {
						const next = checked ? vals().filter((x) => x !== o.value) : [...vals(), o.value];
						setVals(next);
						rt.ctl.fire(p.node, "change", P.texts(next));
					} else {
						setVal(o.value);
						rt.ctl.fire(p.node, "change", P.text(o.value));
					}
				},
			});
		}
		const b = boundsOf(el);
		openMenu(b ? { rect: b } : { x: e?.x ?? 0, y: e?.y ?? 0 }, items, { minWidth: b?.width });
	};
	return (
		<div
			{...noClick(p.handlers)}
			ref={(x: HostElement) => {
				el = x;
				p.reg(x);
			}}
			role="combobox"
			tabIndex={disabled(p) ? undefined : 0}
			onClick={open}
			onKeyDown={(e: EventPayload) => {
				const k = (e.key ?? "").toLowerCase();
				if (k === "enter" || k === "space" || k === "down" || k === "up") {
					open();
					stop(e);
				}
			}}
			style={{ ...t("flex h-7 items-center justify-between rounded-md border border-input bg-transparent px-2 shadow-xs"), keyboardFocusDim: false, ...focusRing(), cursor: disabled(p) ? "default" : "pointer", opacity: disabled(p) ? 0.6 : 1, minWidth: 120, ...p.box() }}
		>
			<text style={{ ...tx(label() ? "text-[13px] text-foreground" : "text-[13px] text-muted-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1 }}>
				{label() || rt.txt(spec().placeholder)}
			</text>
			<Icon name="chevrons-up-down" size={14} color={tok("muted-foreground")} style={{ marginLeft: 8 }} />
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- text input

/** Suggestions under a field: local `items`, or the plugin's `ui-events.suggest` after the debounce. */
function useSuggestions(p: KindProps, text: () => string) {
	const rt = useRt();
	const [items, setItems] = createSignal<Suggestion[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => timer && clearTimeout(timer));
	createEffect(
		on(text, (q) => {
			const s = (p.node.kind.val?.suggest ?? undefined) as { items: Suggestion[]; dynamic: boolean; minChars: number; debounceMs: number } | undefined;
			if (timer) clearTimeout(timer);
			if (!s || q.length < (s.minChars ?? 1)) return setItems([]);
			if (s.dynamic && p.node.props.key) {
				timer = setTimeout(async () => setItems((await rt.ctl.suggest(p.node.props.key!, q, 8)).slice(0, 8)), s.debounceMs ?? 150);
				return;
			}
			const ql = q.toLowerCase();
			setItems((s.items ?? []).filter((i) => rt.txt(i.label).toLowerCase().includes(ql) || i.value.toLowerCase().includes(ql)).slice(0, 8));
		}),
	);
	return items;
}

const SuggestList = (p: { items: Suggestion[]; onPick: (s: Suggestion) => void; txt: (t: any) => string }) => (
	<div style={{ ...t("flex flex-col rounded-md border bg-popover p-1 shadow-md"), marginTop: 2 }}>
		<For each={p.items}>
			{(s) => (
				<div onMouseDown={() => p.onPick(s)} style={{ ...t("flex items-center gap-2 rounded-sm px-2 py-1"), cursor: "pointer", hover: { backgroundColor: tok("accent") } }}>
					<Show when={s.icon}>
						<UiIcon icon={s.icon} size={14} color={tok("muted-foreground")} />
					</Show>
					<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap" }}>{p.txt(s.label)}</text>
					<Show when={s.detail}>
						<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{p.txt(s.detail)}</text>
					</Show>
				</div>
			)}
		</For>
	</div>
);

const TextInputK: KindComponent = (p) => {
	const rt = useRt();
	const form = useContext(FormCtx);
	const spec = () => p.node.kind.val ?? {};
	const [val, setVal] = useHostValue<string>(p, () => spec().value ?? "", (v) => (v.tag === "text" ? v.val : undefined), (v) => ({ tag: "text", val: v }));
	useField(p, "text", val);
	const [focused, setFocused] = createSignal(false);
	let committed = untrack(val);
	const suggestions = useSuggestions(p, () => (focused() ? val() : ""));
	const commit = () => {
		if (val() === committed) return;
		committed = val();
		rt.ctl.fire(p.node, "change", P.text(val()));
	};
	const edit = (v: string) => {
		const max = spec().maxLength as number | undefined;
		const next = max !== undefined && v.length > max ? v.slice(0, max) : v;
		setVal(next);
		rt.ctl.fire(p.node, "input", P.text(next));
	};
	const inline = () => spec().look === "inline" && !focused();
	const frame = (): Record<string, unknown> => ({
		...t(spec().multiline ? "flex w-full min-w-0 rounded-md border bg-transparent px-2 py-1" : "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border bg-transparent px-2"),
		borderColor: inline() ? "transparent" : focused() ? tok("ring") : tok("input"),
		...(focused() ? { boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color: withAlpha(tok("ring"), 0.3) }] } : {}),
		...(spec().multiline ? { minHeight: 64 } : {}),
		opacity: disabled(p) ? 0.6 : 1,
	});
	const field: Record<string, unknown> = { flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: "Inter", keyboardFocusDim: false, color: tok("foreground") };
	const submit = () => {
		commit();
		if (form) form.submit();
		else {
			rt.ctl.fire(p.node, "submit", P.form(rt.ctl.formValues()));
			if (!spec().multiline) rt.ctl.onDefaultAction?.();
		}
	};
	const onKey = (e: EventPayload) => {
		const k = (e.key ?? "").toLowerCase();
		if (k === "enter" && spec().multiline && modsOf(e).ctrl) submit();
		(p.handlers.onKeyDown as ((e: EventPayload) => void) | undefined)?.(e);
		void domKey;
	};
	const onFocus = () => {
		setFocused(true);
		rt.ctl.fire(p.node, "focus");
	};
	const onBlur = () => {
		setFocused(false);
		commit();
		rt.ctl.fire(p.node, "blur");
	};
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<div style={frame()}>
				<Show when={spec().prefixIcon}>
					<UiIcon icon={spec().prefixIcon} size={14} color={tok("muted-foreground")} />
				</Show>
				<Show
					when={spec().multiline}
					fallback={
						<input
							value={val()}
							placeholder={rt.txt(spec().placeholder)}
							readOnly={!!spec().readOnly || disabled(p)}
							autoFocus={p.node.props.autoFocus}
							onChange={(e: EventPayload) => edit(e.value ?? "")}
							onSubmit={submit}
							onKeyDown={onKey}
							onFocus={onFocus}
							onBlur={onBlur}
							style={{ ...field, height: 26 }}
							theme={inputTheme(rt)}
							ref={p.reg}
						/>
					}
				>
					<textarea
						value={val()}
						placeholder={rt.txt(spec().placeholder)}
						readOnly={!!spec().readOnly || disabled(p)}
						minRows={spec().minRows ?? 3}
						maxRows={spec().maxRows}
						autoFocus={p.node.props.autoFocus}
						onChange={(e: EventPayload) => edit(e.value ?? "")}
						onKeyDown={onKey}
						onFocus={onFocus}
						onBlur={onBlur}
						style={field}
						theme={inputTheme(rt)}
						ref={p.reg}
					/>
				</Show>
				<Show when={spec().clearButton && val().length > 0 && !spec().readOnly}>
					<div
						role="button"
						aria-label="Clear"
						onClick={() => {
							edit("");
							commit();
						}}
						style={{ cursor: "pointer", display: "flex" }}
					>
						<Icon name="x" size={14} color={tok("muted-foreground")} />
					</div>
				</Show>
			</div>
			<Show when={focused() && suggestions().length > 0}>
				<SuggestList
					items={suggestions()}
					txt={rt.txt}
					onPick={(s) => {
						setVal(s.value);
						committed = s.value;
						rt.ctl.fire(p.node, "input", P.text(s.value));
						rt.ctl.fire(p.node, "change", P.text(s.value));
					}}
				/>
			</Show>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- number, slider

const NumberInputK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const fmt = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? "" : String(n));
	const [text, setText] = createSignal(untrack(() => fmt(spec().value)));
	createEffect(on(() => spec().value, (v) => setText(fmt(v as number | undefined)), { defer: true }));
	const [focused, setFocused] = createSignal(false);
	const parsed = () => {
		const s = text().trim();
		if (s === "") return undefined;
		let n = Number(s);
		if (!Number.isFinite(n)) return undefined;
		if (spec().min !== undefined) n = Math.max(spec().min, n);
		if (spec().max !== undefined) n = Math.min(spec().max, n);
		return n;
	};
	useField(p, "number", () => parsed() ?? 0);
	const commit = () => {
		const n = parsed();
		setText(fmt(n));
		rt.ctl.fire(p.node, "change", n === undefined ? P.value({ tag: "none" }) : P.number(n));
	};
	const bump = (dir: number) => {
		const step = (spec().step as number | undefined) ?? 1;
		let n = (parsed() ?? 0) + dir * step;
		if (spec().min !== undefined) n = Math.max(spec().min, n);
		if (spec().max !== undefined) n = Math.min(spec().max, n);
		setText(fmt(+n.toFixed(10)));
		rt.ctl.fire(p.node, "input", P.number(n));
		rt.ctl.fire(p.node, "change", P.number(n));
	};
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, ...p.box() }}>
			<div style={{ ...t("flex h-7 w-28 min-w-0 items-center rounded-md border bg-transparent px-2"), borderColor: focused() ? tok("ring") : tok("input"), opacity: disabled(p) ? 0.6 : 1 }}>
				<input
					value={text()}
					placeholder={rt.txt(spec().placeholder)}
					readOnly={disabled(p)}
					onChange={(e: EventPayload) => {
						setText((e.value ?? "").replace(/[^0-9eE+\-.]/g, ""));
						const n = parsed();
						if (n !== undefined) rt.ctl.fire(p.node, "input", P.number(n));
					}}
					onKeyDown={(e: EventPayload) => {
						const k = (e.key ?? "").toLowerCase();
						if (k === "up") bump(1);
						else if (k === "down") bump(-1);
						else if (k === "enter") commit();
					}}
					onFocus={() => setFocused(true)}
					onBlur={() => {
						setFocused(false);
						commit();
					}}
					style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: "Inter", height: 26, keyboardFocusDim: false, color: tok("foreground") }}
					theme={inputTheme(rt)}
					ref={p.reg}
				/>
				<div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
					<div onClick={() => bump(1)} style={{ cursor: "pointer", display: "flex", height: 11 }}>
						<Icon name="chevron-up" size={11} color={tok("muted-foreground")} />
					</div>
					<div onClick={() => bump(-1)} style={{ cursor: "pointer", display: "flex", height: 11 }}>
						<Icon name="chevron-down" size={11} color={tok("muted-foreground")} />
					</div>
				</div>
			</div>
			<Show when={spec().unit}>
				<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{rt.txt(spec().unit)}</text>
			</Show>
		</div>
	);
};

const SliderK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [val, setVal] = useHostValue<number>(p, () => spec().value ?? 0, (v) => (v.tag === "integer" ? v.val : undefined), (v) => ({ tag: "integer", val: Math.round(v) }));
	useField(p, "number", val);
	let track: HostElement | undefined;
	const [dragging, setDragging] = createSignal(false);
	const min = () => spec().min ?? 0;
	const max = () => spec().max ?? 1;
	const frac = () => (max() === min() ? 0 : Math.min(1, Math.max(0, (val() - min()) / (max() - min()))));
	const snap = (n: number) => {
		const s = spec().step as number | undefined;
		return Math.min(max(), Math.max(min(), s ? Math.round((n - min()) / s) * s + min() : n));
	};
	const at = (e: EventPayload) => {
		const b = boundsOf(track);
		if (!b || b.width <= 0) return;
		const n = +snap(min() + (((e.x ?? b.x) - b.x) / b.width) * (max() - min())).toFixed(10);
		if (n !== val()) {
			setVal(n);
			rt.ctl.fire(p.node, "input", P.number(n));
		}
	};
	const W = 14;
	const release = () => {
		setDragging(false);
		rt.ctl.fire(p.node, "change", P.number(val()));
	};
	return (
		<div {...noClick(p.handlers)} role="slider" aria-valuetext={String(val())} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10, opacity: disabled(p) ? 0.5 : 1, ...p.box() }}>
			<div
				ref={(x: HostElement) => {
					track = x;
					p.reg(x);
				}}
				onMouseDown={(e: EventPayload) => {
					if (disabled(p)) return;
					setDragging(true);
					at(e);
				}}
				style={{ position: "relative", flexGrow: 1, height: 20, display: "flex", alignItems: "center", cursor: "pointer", minWidth: 80 }}
			>
				<div style={{ width: "100%", height: 4, borderRadius: 2, backgroundColor: tok("secondary"), display: "flex" }}>
					<div style={{ width: `${frac() * 100}%`, height: 4, borderRadius: 2, backgroundColor: tok("primary") }} />
				</div>
				<div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 20, display: "flex", flexDirection: "row", alignItems: "center", pointerEvents: "none" }}>
					<div style={{ flexGrow: frac() * 1000 + 0.001, flexBasis: 0 }} />
					<div style={{ width: 0, height: W, display: "flex", overflow: "visible" }}>
						<div style={{ marginLeft: -W / 2, width: W, height: W, borderRadius: W / 2, backgroundColor: tok("background"), borderWidth: 2, borderColor: tok("primary"), flexShrink: 0 }} />
					</div>
					<div style={{ flexGrow: (1 - frac()) * 1000 + 0.001, flexBasis: 0 }} />
				</div>
				<Show when={dragging()}>
					<anchored fill="window" priority={1000} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}>
						<div
							onMouseMove={(e: EventPayload) => {
								if (e.pressedButton === undefined || e.pressedButton === null) return release();
								at(e);
							}}
							onMouseUp={release}
							style={{ width: "100%", height: "100%" }}
						/>
					</anchored>
				</Show>
			</div>
			<Show when={spec().showValue}>
				<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap", minWidth: 28 }}>{String(+val().toFixed(3))}</text>
			</Show>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- colour, date

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const ColorInputK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [val, setVal] = useHostValue<string>(p, () => spec().value ?? "#000000", (v) => (v.tag === "text" ? v.val : undefined), (v) => ({ tag: "text", val: v }));
	useField(p, "color", val);
	const [draft, setDraft] = createSignal(untrack(val));
	createEffect(on(val, (v) => setDraft(v)));
	const apply = (hex: string, fire = true) => {
		if (!HEX.test(hex) || (hex.length === 9 && !spec().alpha)) return false;
		setVal(hex.toLowerCase());
		if (fire) {
			rt.ctl.fire(p.node, "input", P.color(hex.toLowerCase()));
			rt.ctl.fire(p.node, "change", P.color(hex.toLowerCase()));
		}
		return true;
	};
	const css = () => (HEX.test(val()) ? rgbaCss(hexToRgba(val())) : "#000000");
	const picked = (c: string) => val().toLowerCase().startsWith(c.toLowerCase());
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", flexDirection: "column", gap: 6, opacity: disabled(p) ? 0.5 : 1, ...p.box() }}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
				<div style={{ width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: tok("input"), backgroundColor: css(), flexShrink: 0 }} />
				<div style={{ ...t("flex h-7 w-28 items-center rounded-md border border-input px-2") }}>
					<input
						value={draft()}
						onChange={(e: EventPayload) => {
							const v = e.value ?? "";
							setDraft(v);
							if (HEX.test(v)) apply(v);
						}}
						onBlur={() => !apply(draft(), false) && setDraft(val())}
						style={{ flexGrow: 1, fontSize: 12, fontFamily: "Cascadia Mono", height: 26, keyboardFocusDim: false, color: tok("foreground") }}
						theme={inputTheme(rt)}
						ref={p.reg}
					/>
				</div>
			</div>
			<Show when={(spec().swatches as string[] | undefined)?.length}>
				<div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
					<For each={spec().swatches as string[]}>
						{(c) => (
							<div
								role="button"
								aria-label={c}
								onClick={() => !disabled(p) && apply(c)}
								style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c, cursor: "pointer", borderWidth: picked(c) ? 2 : 1, borderColor: picked(c) ? tok("foreground") : tok("border") }}
							/>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

const DATE_RE: Record<string, RegExp> = {
	date: /^\d{4}-\d{2}-\d{2}$/,
	"date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
	time: /^\d{2}:\d{2}(:\d{2})?$/,
};
const DATE_HINT: Record<string, string> = { date: "YYYY-MM-DD", "date-time": "YYYY-MM-DDTHH:MM", time: "HH:MM" };

const DateInputK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const kind = () => spec().kind ?? "date";
	const [val, setVal] = useHostValue<string>(p, () => spec().value ?? "", (v) => (v.tag === "text" ? v.val : undefined), (v) => ({ tag: "text", val: v }));
	useField(p, "text", val);
	const [draft, setDraft] = createSignal(untrack(val));
	createEffect(on(val, (v) => setDraft(v)));
	const valid = (s: string) =>
		s === "" || (DATE_RE[kind()]!.test(s) && !Number.isNaN(Date.parse(kind() === "time" ? `1970-01-01T${s}` : s)) && (!spec().min || s >= spec().min) && (!spec().max || s <= spec().max));
	const commit = () => {
		if (!valid(draft())) return setDraft(val());
		if (draft() !== val()) {
			setVal(draft());
			rt.ctl.fire(p.node, "change", P.text(draft()));
		}
	};
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, opacity: disabled(p) ? 0.5 : 1, ...p.box() }}>
			<div style={{ ...t("flex h-7 w-44 items-center gap-1.5 rounded-md border px-2"), borderColor: valid(draft()) ? tok("input") : tok("destructive") }}>
				<Icon name={kind() === "time" ? "clock" : "calendar"} size={14} color={tok("muted-foreground")} />
				<input
					value={draft()}
					placeholder={DATE_HINT[kind()]}
					readOnly={disabled(p)}
					onChange={(e: EventPayload) => setDraft(e.value ?? "")}
					onKeyDown={(e: EventPayload) => (e.key ?? "").toLowerCase() === "enter" && commit()}
					onBlur={commit}
					style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: "Inter", height: 26, keyboardFocusDim: false, color: tok("foreground") }}
					theme={inputTheme(rt)}
					ref={p.reg}
				/>
			</div>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- token input

type Tok = { id: string; label: any; color?: any };

const TokenInputK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [tokens, setTokens] = createSignal<Tok[]>(untrack(() => (spec().tokens as Tok[]) ?? []));
	createEffect(on(() => JSON.stringify((spec().tokens as Tok[] | undefined)?.map((x) => x.id)), () => setTokens((spec().tokens as Tok[]) ?? []), { defer: true }));
	useField(p, "texts", () => tokens().map((x) => x.id));
	const [text, setText] = createSignal("");
	const [focused, setFocused] = createSignal(false);
	const suggestions = useSuggestions(p, () => (focused() ? text() : ""));
	const emit = (next: Tok[]) => {
		setTokens(next);
		rt.ctl.fire(p.node, "change", P.texts(next.map((x) => x.id)));
	};
	const add = (id: string, label?: any) => {
		const v = id.trim();
		if (!v || tokens().some((x) => x.id === v)) return setText("");
		setText("");
		emit([...tokens(), { id: v, label: label ?? { tag: "plain", val: v } }]);
	};
	return (
		<div {...noClick(p.handlers)} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<div style={{ ...t("flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md border px-1.5 py-1"), borderColor: focused() ? tok("ring") : tok("input"), flexDirection: "row", opacity: disabled(p) ? 0.6 : 1 }}>
				<For each={tokens()}>
					{(tk) => (
						<div style={{ ...t("flex h-5 items-center gap-1 rounded-full px-2"), backgroundColor: tok("primary-tint") }}>
							<text style={{ ...tx("text-xs font-medium"), color: tok("primary-deep"), whiteSpace: "nowrap" }}>{rt.txt(tk.label)}</text>
							<div role="button" aria-label="Remove" onClick={() => !disabled(p) && emit(tokens().filter((x) => x.id !== tk.id))} style={{ cursor: "pointer", display: "flex" }}>
								<Icon name="x" size={11} color={tok("primary-deep")} />
							</div>
						</div>
					)}
				</For>
				<input
					value={text()}
					placeholder={tokens().length ? "" : rt.txt(spec().placeholder)}
					readOnly={disabled(p)}
					onChange={(e: EventPayload) => setText(e.value ?? "")}
					onKeyDown={(e: EventPayload) => {
						const k = (e.key ?? "").toLowerCase();
						if ((k === "enter" || k === "tab") && text().trim() && spec().allowNew) add(text());
						else if (k === "backspace" && !text() && tokens().length) emit(tokens().slice(0, -1));
					}}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					style={{ flexGrow: 1, minWidth: 80, fontSize: 13, fontFamily: "Inter", height: 22, keyboardFocusDim: false, color: tok("foreground") }}
					theme={inputTheme(rt)}
					ref={p.reg}
				/>
			</div>
			<Show when={focused() && suggestions().length > 0}>
				<SuggestList items={suggestions()} txt={rt.txt} onPick={(s) => add(s.value, s.label)} />
			</Show>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- form

const FormK: KindComponent = (p) => {
	const rt = useRt();
	const scope = {
		id: p.node.id,
		busy: () => !!p.node.kind.val?.busy,
		submit: () => {
			if (p.node.kind.val?.busy) return;
			rt.ctl.fire(p.node, "submit", P.form(rt.ctl.formValues(p.node.id)));
		},
	};
	return (
		<FormCtx.Provider value={scope}>
			<div {...p.handlers} role="form" style={{ display: "flex", flexDirection: "column", gap: 8, ...p.box() }}>
				<Children node={p.node} />
			</div>
		</FormCtx.Provider>
	);
};

export const inputs: Record<string, KindComponent> = {
	button: ButtonK,
	checkbox: CheckboxK,
	switch: SwitchK,
	"radio-group": RadioGroupK,
	select: SelectK,
	"text-input": TextInputK,
	"number-input": NumberInputK,
	slider: SliderK,
	"color-input": ColorInputK,
	"date-input": DateInputK,
	"token-input": TokenInputK,
	form: FormK,
};
