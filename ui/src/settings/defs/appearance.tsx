// Appearance: light/dark mode, colour scheme, interface font and text size. Applied live to this window and to the reader
// iframes (see ../appearance.ts and reader-next/src/viewer/theme.ts).
import { createMemo, For, Show } from "solid-js";
import { Check, Palette } from "lucide-solid";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { Segmented, Select } from "../controls";
import {
	accentFor, cleanFamily, computeVars, DEFAULT_THEME, FONT_SUGGESTIONS, FONTS, resolveDark, SCHEMES, setTheme, TEXT_SIZES, theme,
	type FontId, type ThemeMode,
} from "../appearance";
import { registerSection, registerSettings } from "../registry";

registerSection({
	id: "appearance", label: "Appearance", icon: Palette, order: 5,
	description: "Light or dark mode, colour scheme, and the interface font.",
	keywords: ["theme", "colour", "color", "dark mode", "light mode", "font", "text size", "accent"],
});

const MODES: { value: ThemeMode; label: string; hint: string }[] = [
	{ value: "light", label: "Light", hint: "Always use the light theme" },
	{ value: "dark", label: "Dark", hint: "Always use the dark theme" },
	{ value: "system", label: "System", hint: "Follow Windows" },
];

const Swatch = (p: { color: string; label: string; active: boolean; onClick: () => void; fg?: string }) => (
	<button
		type="button"
		role="radio"
		aria-checked={p.active}
		aria-label={p.label}
		title={p.label}
		class={cn("relative inline-flex size-7 items-center justify-center rounded-full border-2 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			p.active ? "border-foreground" : "border-transparent hover:border-input")}
		onClick={p.onClick}
	>
		<span class="flex size-5 items-center justify-center rounded-full" style={{ background: p.color }}>
			<Show when={p.active}><Check class="size-3" style={{ color: p.fg ?? "#fff" }} /></Show>
		</span>
	</button>
);

const SchemePicker = () => {
	const dark = () => (theme(), resolveDark(theme().mode));
	const colours = createMemo(() => SCHEMES.map((s) => ({ s, a: accentFor(s.h, s.c, dark() ? s.lDark : s.lLight, dark()) })));
	const custom = createMemo(() => {
		const v = computeVars({ ...theme(), scheme: "custom" })[dark() ? "dark" : "light"];
		return { bg: v["--primary"], fg: v["--primary-foreground"] };
	});
	const active = () => theme().scheme;
	return (
		<div class="space-y-1.5" data-testid="settings-schemes">
			<div role="radiogroup" aria-label="Colour scheme" class="flex flex-wrap items-center gap-1">
				<For each={colours()}>{(c) => (
					<Swatch color={c.a.primary} label={c.s.label + (c.s.id === "blue" ? " (default)" : "")} active={active() === c.s.id}
						fg={c.a.foreground} onClick={() => setTheme({ scheme: c.s.id })} />
				)}</For>
				<span class="mx-1 h-5 w-px bg-border" />
				<label class="relative inline-flex items-center gap-1.5 text-xs" title="Pick any accent colour">
					<Swatch color={active() === "custom" ? custom().bg : "conic-gradient(#e5484d, #f5a524, #46a758, #3e63dd, #8e4ec6, #e5484d)"} fg={custom().fg} label="Custom colour" active={active() === "custom"} onClick={() => setTheme({ scheme: "custom" })} />
					<input
						type="color"
						aria-label="Custom accent colour"
						class="h-6 w-8 cursor-pointer rounded border border-input bg-background p-0.5"
						value={theme().accent}
						onInput={(e) => setTheme({ scheme: "custom", accent: e.currentTarget.value })}
					/>
					<span class="text-muted-foreground">Custom</span>
				</label>
			</div>
			<p class="text-xs text-muted-foreground">
				{SCHEMES.find((s) => s.id === active())?.label ?? "Custom"} · button text is chosen automatically for at least 4.5:1 contrast.
			</p>
		</div>
	);
};

const FontPicker = () => {
	const known = (id: FontId) => id === "custom" || FONTS.some((f) => f.id === id);
	return (
		<div class="space-y-2" data-testid="settings-font">
			<div class="flex flex-wrap items-center gap-2">
				<Select<FontId> label="Interface font" value={known(theme().font) ? theme().font : "manrope"} onChange={(v) => setTheme({ font: v })}
					options={[...FONTS.map((f) => ({ value: f.id, label: f.id === "manrope" ? "Manrope (default)" : f.label })), { value: "custom" as FontId, label: "Other…" }]} />
				<Show when={theme().font === "custom"}>
					<input
						type="text"
						list="zn-font-suggestions"
						aria-label="Font name"
						placeholder="Installed font name, e.g. Aptos"
						class="h-7 w-56 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
						value={theme().fontCustom}
						onChange={(e) => setTheme({ fontCustom: cleanFamily(e.currentTarget.value) })}
						onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
					/>
					<datalist id="zn-font-suggestions"><For each={FONT_SUGGESTIONS}>{(f) => <option value={f} />}</For></datalist>
				</Show>
			</div>
			<p class="max-w-xl rounded-md border bg-muted/40 px-2.5 py-2 text-sm" aria-label="Font preview">
				The quick brown fox jumps over the lazy dog. Borakati et al., 2026 — 0123456789
			</p>
			<Show when={theme().font === "custom" && !theme().fontCustom}>
				<p class="text-xs text-muted-foreground">Type the name of a font installed on this computer. Until you do, the system font is used.</p>
			</Show>
		</div>
	);
};

registerSettings([
	{
		id: "appearance.mode", section: "appearance", label: "Theme",
		description: "Light, dark, or follow Windows.",
		keywords: ["dark mode", "light mode", "system", "night", "day", "colour scheme"],
		control: () => <Segmented<ThemeMode> label="Theme" value={theme().mode} onChange={(v) => setTheme({ mode: v })} options={MODES} />,
	},
	{
		id: "appearance.scheme", section: "appearance", label: "Colour scheme", layout: "block",
		description: "The accent used for buttons, selection and focus rings, in both light and dark.",
		keywords: ["accent", "colour", "color", "blue", "teal", "violet", "rose", "amber", "graphite", "custom colour", "primary"],
		control: () => <SchemePicker />,
	},
	{
		id: "appearance.font", section: "appearance", label: "Interface font", layout: "block",
		description: "The font for menus, lists and panels. The reading view keeps its own font setting.",
		keywords: ["typeface", "system font", "manrope", "inter", "ibm plex", "source sans", "segoe", "other font"],
		control: () => <FontPicker />,
	},
	{
		id: "appearance.size", section: "appearance", label: "Text size",
		description: "Base size of interface text. The default is 13 px.",
		keywords: ["font size", "zoom", "larger", "smaller", "scale"],
		control: () => (
			<Segmented<string> label="Text size" value={String(theme().size)} onChange={(v) => setTheme({ size: Number(v) })}
				options={TEXT_SIZES.map((n) => ({ value: String(n), label: n === 13 ? "13 px (default)" : `${n} px` }))} />
		),
	},
	{
		id: "appearance.reset", section: "appearance", label: "Reset appearance",
		description: "Back to System theme, Blue, Manrope, 13 px.",
		keywords: ["default", "restore"],
		control: () => <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={() => setTheme({ ...DEFAULT_THEME })}>Reset</Button>,
	},
]);
