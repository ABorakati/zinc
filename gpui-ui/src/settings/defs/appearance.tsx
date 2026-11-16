// Appearance: light/dark/system, colour scheme, interface font and text size. Applied live (shell/appearance.ts).
import { createMemo, For, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import {
	accentFor,
	cleanFamily,
	DEFAULT_THEME,
	FONTS,
	FONT_SUGGESTIONS,
	resolveMode,
	SCHEMES,
	setThemePrefs,
	resetThemePrefs,
	TEXT_SIZES,
	themePrefs,
	type FontId,
	type ThemeMode,
} from "../../shell/appearance";
import { Txt, t, tok } from "../../shell/kit";
import { Btn, Choice, Segmented, TextField } from "../controls";
import { registerSection, registerSettings } from "../registry";

registerSection({
	id: "appearance",
	label: "Appearance",
	icon: "palette",
	order: 5,
	description: "Light or dark mode, colour scheme, and the interface font.",
	keywords: ["theme", "colour", "color", "dark mode", "light mode", "font", "text size", "accent"],
});

const MODES: { value: ThemeMode; label: string; hint: string }[] = [
	{ value: "light", label: "Light", hint: "Always use the light theme" },
	{ value: "dark", label: "Dark", hint: "Always use the dark theme" },
	{ value: "system", label: "System", hint: "Follow Windows" },
];

function Swatch(p: { color: string; label: string; active: boolean; fg: string; onClick: () => void }): JSX.Element {
	return (
		<div
			onClick={p.onClick}
			aria-label={p.label}
			style={{
				...t("flex size-7 items-center justify-center rounded-full"),
				cursor: "pointer",
				borderWidth: 2,
				borderColor: p.active ? tok("foreground") : "rgba(0, 0, 0, 0)",
				hover: p.active ? undefined : { borderColor: tok("input") },
			}}
		>
			<div
				style={{
					width: 20,
					height: 20,
					borderRadius: 10,
					backgroundColor: p.color,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<Show when={p.active}>
					<Icon name="check" size={12} color={p.fg} strokeWidth={3} />
				</Show>
			</div>
		</div>
	);
}

const HEX = /^#[0-9a-f]{6}$/i;

function SchemePicker(): JSX.Element {
	const dark = () => resolveMode() === "dark";
	const colours = createMemo(() =>
		SCHEMES.map((s) => {
			const pal = s.palette?.[dark() ? "dark" : "light"];
			const a = pal
				? { primary: pal["--primary"]!, foreground: pal["--primary-foreground"]! }
				: accentFor(s.h, s.c, dark() ? s.lDark : s.lLight, dark());
			return { s, a };
		}),
	);
	const active = () => themePrefs().scheme;
	const custom = createMemo(() => {
		const a = accentFor(0, 0.12, 0.5, dark());
		return { fg: a.foreground };
	});
	return (
		<div style={t("flex flex-col gap-1.5")}>
			<div style={t("flex flex-wrap items-center gap-1")}>
				<For each={colours()}>
					{(c) => (
						<Swatch
							color={c.a.primary}
							fg={c.a.foreground}
							label={c.s.label + (c.s.id === DEFAULT_THEME.scheme ? " (default)" : "")}
							active={active() === c.s.id}
							onClick={() => setThemePrefs({ scheme: c.s.id })}
						/>
					)}
				</For>
				<div style={{ ...t("bg-border"), width: 1, height: 20, marginLeft: 4, marginRight: 4 }} />
				<Swatch
					color={HEX.test(themePrefs().accent) ? themePrefs().accent : "#2f6fdc"}
					fg={custom().fg}
					label="Custom colour"
					active={active() === "custom"}
					onClick={() => setThemePrefs({ scheme: "custom" })}
				/>
				<Txt cls="text-xs text-muted-foreground">Custom</Txt>
			</div>
			<Show when={active() === "custom"}>
				<TextField
					value={themePrefs().accent}
					placeholder="#rrggbb"
					width={140}
					onCommit={(v) => {
						const h = v.trim().startsWith("#") ? v.trim() : `#${v.trim()}`;
						if (HEX.test(h)) setThemePrefs({ scheme: "custom", accent: h.toLowerCase() });
					}}
				/>
			</Show>
			<Txt cls="text-xs text-muted-foreground">{`${SCHEMES.find((s) => s.id === active())?.label ?? "Custom"} · button text is chosen automatically for at least 4.5:1 contrast.`}</Txt>
		</div>
	);
}

function FontPicker(): JSX.Element {
	const known = (id: FontId) => id === "custom" || FONTS.some((f) => f.id === id);
	const options = [
		...FONTS.map((f) => ({ value: f.id as FontId, label: f.id === DEFAULT_THEME.font ? `${f.label} (default)` : f.label })),
		{ value: "custom" as FontId, label: "Other…" },
	];
	return (
		<div style={t("flex flex-col gap-2")}>
			<div style={t("flex flex-wrap items-center gap-2")}>
				<Choice<FontId>
					value={known(themePrefs().font) ? themePrefs().font : "inter"}
					options={options}
					onChange={(v) => setThemePrefs({ font: v })}
					width={200}
				/>
				<Show when={themePrefs().font === "custom"}>
					<TextField
						value={themePrefs().fontCustom}
						placeholder="Installed font, e.g. Aptos"
						width={220}
						onCommit={(v) => setThemePrefs({ fontCustom: cleanFamily(v) })}
					/>
				</Show>
			</div>
			<div style={{ ...t("rounded-md border bg-muted px-2.5 py-2"), maxWidth: 560 }}>
				<Txt cls="text-sm text-foreground">The quick brown fox jumps over the lazy dog. Borakati et al., 2026 — 0123456789</Txt>
			</div>
			<Show when={themePrefs().font === "custom"}>
				<Txt cls="text-xs text-muted-foreground">{`Type the name of a font installed on this computer, then Apply. Suggestions: ${FONT_SUGGESTIONS.slice(0, 6).join(", ")}.`}</Txt>
			</Show>
		</div>
	);
}

registerSettings([
	{
		id: "appearance.mode",
		section: "appearance",
		label: "Theme",
		description: "Light, dark, or follow Windows.",
		keywords: ["dark mode", "light mode", "system", "night", "day", "colour scheme"],
		control: () => <Segmented<ThemeMode> value={themePrefs().mode} onChange={(mode) => setThemePrefs({ mode })} options={MODES} />,
	},
	{
		id: "appearance.scheme",
		section: "appearance",
		label: "Colour scheme",
		layout: "block",
		description: "The accent used for buttons, selection and focus rings, in both light and dark.",
		keywords: [
			"accent",
			"colour",
			"color",
			"blue",
			"teal",
			"violet",
			"rose",
			"amber",
			"graphite",
			"custom colour",
			"primary",
			"quiet paper",
		],
		control: () => <SchemePicker />,
	},
	{
		id: "appearance.font",
		section: "appearance",
		label: "Interface font",
		layout: "block",
		description: "The font for menus, lists and panels. Item titles keep their serif.",
		keywords: ["typeface", "system font", "manrope", "inter", "ibm plex", "source sans", "segoe", "other font"],
		control: () => <FontPicker />,
	},
	{
		id: "appearance.size",
		section: "appearance",
		label: "Text size",
		description: "Base size of interface text. The default is 13 px.",
		keywords: ["font size", "zoom", "larger", "smaller", "scale"],
		control: () => (
			<Segmented<string>
				value={String(themePrefs().size)}
				onChange={(v) => setThemePrefs({ size: Number(v) })}
				options={TEXT_SIZES.map((n) => ({ value: String(n), label: n === 13 ? "13 px (default)" : `${n} px` }))}
			/>
		),
	},
	{
		id: "appearance.reset",
		section: "appearance",
		label: "Reset appearance",
		description: "Back to System theme, Quiet Paper, Inter, 13 px.",
		keywords: ["default", "restore"],
		control: () => <Btn onClick={resetThemePrefs}>Reset</Btn>,
	},
]);
