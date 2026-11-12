// The reading view's "Aa" panel: font, size, line spacing, text width and theme. Every choice previews itself: a font button is
// set in that font, a theme button is painted in that theme's paper and ink. "Custom" takes any font installed on this computer
// (typed, or picked from the installed families that match, each shown in its own face).
import type { EventPayload } from "@gpuix/native";
import { createMemo, createResource, createSignal, For, onMount, Show, type Accessor, type JSX } from "solid-js";
import { ensureFamily, needsRegistering } from "../../fonts";
import { Icon } from "../../icons";
import { cleanFamily } from "../../shell/schemes";
import { installedFonts, matchFonts } from "../../shell/installedFonts";
import { withAlpha } from "../../theme";
import { FONTS, LIMITS, themeColors, type FontKind, type Palette, type ReadingSettings, type ThemeKind } from "./settings";

export interface ChipProps { label?: string; icon?: string; on?: boolean; onClick: () => void; w?: number; disabled?: boolean; refEl?: (el: { id: number }) => void }
export type ChipComponent = (c: ChipProps) => JSX.Element;

/** GPUIX only hit-tests a box that paints something: an unfilled clickable never gets its click. Almost no alpha still counts. */
export const hitFillOf = (pal: Palette) => withAlpha(pal.bg, 0.02);

/** The view's toolbar / panel button, in the reading palette. */
export function makeChip(pal: Accessor<Palette>): ChipComponent {
	return (c) => (
		<div
			ref={(el: { id: number }) => c.refEl?.(el)}
			onClick={() => { if (!c.disabled) c.onClick(); }}
			style={{
				display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 6, flexShrink: 0,
				borderWidth: 1, borderColor: c.on ? pal().fg : pal().rule, backgroundColor: c.on ? pal().panel : hitFillOf(pal()), cursor: c.disabled ? "default" : "pointer",
				opacity: c.disabled ? 0.45 : 1, ...(c.w ? { width: c.w } : {}),
			}}
		>
			<Show when={c.icon}><Icon name={c.icon!} size={13} color={pal().fg} /></Show>
			<Show when={c.label}><text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 12, whiteSpace: "nowrap" }}>{c.label!}</text></Show>
		</div>
	);
}

const THEMES: { id: Exclude<ThemeKind, "custom">; label: string }[] = [{ id: "light", label: "Light" }, { id: "sepia", label: "Sepia" }, { id: "dark", label: "Dark" }];
const LABEL_W = 74;
const step = (v: number, d: number, [lo, hi]: readonly [number, number], dp = 0) => Math.min(hi, Math.max(lo, Math.round((v + d) * 10 ** dp) / 10 ** dp));

export function SettingsPanel(p: { pal: Accessor<Palette>; settings: Accessor<ReadingSettings>; setSettings(patch: Partial<ReadingSettings>): void; reset(): void; Chip: ChipComponent }): JSX.Element {
	const pal = p.pal, st = p.settings, Chip = p.Chip;
	const hit = () => hitFillOf(pal());

	// Bundled faces the buttons preview (Literata) are registered once the panel is on screen, then the buttons switch to them.
	const [facesReady, setFacesReady] = createSignal(!FONTS.some((f) => needsRegistering(f.family)));
	onMount(() => { if (!facesReady()) setTimeout(() => { for (const f of FONTS) ensureFamily(f.family); setFacesReady(true); }, 0); });
	const face = (family: string) => (facesReady() || !needsRegistering(family) ? family : "Inter");

	const label = (t: string): JSX.Element => <text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11, width: LABEL_W, flexShrink: 0 }}>{t}</text>;
	const divider = () => <div style={{ width: 1, height: 18, backgroundColor: pal().rule, marginLeft: 4, marginRight: 4, flexShrink: 0 }} />;

	/** A choice button whose label is drawn in `family`. */
	function FontChip(c: { label: string; family: string; on: boolean; onClick(): void; muted?: boolean }): JSX.Element {
		return (
			<div
				onClick={c.onClick}
				style={{
					display: "flex", alignItems: "center", justifyContent: "center", height: 30, paddingLeft: 11, paddingRight: 11, borderRadius: 6, flexShrink: 0, cursor: "pointer",
					borderWidth: 1, borderColor: c.on ? pal().fg : pal().rule, backgroundColor: c.on ? pal().panel : hit(), hover: { borderColor: c.on ? pal().fg : pal().muted },
				}}
			>
				<text style={{ color: c.muted ? pal().muted : pal().fg, fontFamily: face(c.family), fontSize: 15, whiteSpace: "nowrap" }}>{c.label}</text>
			</div>
		);
	}

	function Stepper(c: { name: string; value: string; dec(): void; inc(): void }): JSX.Element {
		return (
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
				{label(c.name)}
				<Chip icon="minus" onClick={c.dec} />
				<div style={{ width: 52, display: "flex", justifyContent: "center" }}><text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 12 }}>{c.value}</text></div>
				<Chip icon="plus" onClick={c.inc} />
			</div>
		);
	}

	/** A theme button painted in that theme: its paper, its ink, a sample in the reading font. */
	function ThemeChip(c: { label: string; bg: string; fg: string; on: boolean; onClick(): void }): JSX.Element {
		return (
			<div
				onClick={c.onClick}
				style={{
					display: "flex", flexDirection: "row", alignItems: "center", gap: 8, height: 34, paddingLeft: 10, paddingRight: 12, borderRadius: 7, flexShrink: 0, cursor: "pointer",
					backgroundColor: c.bg, borderWidth: c.on ? 2 : 1, borderColor: c.on ? pal().cite : withAlpha(pal().fg, 0.22),
				}}
			>
				<text style={{ color: c.fg, fontFamily: face(fontOf(st())), fontSize: 17, fontWeight: 500 }}>Aa</text>
				<text style={{ color: c.fg, fontFamily: "Inter", fontSize: 12 }}>{c.label}</text>
				<Show when={c.on}><Icon name="check" size={12} color={c.fg} /></Show>
			</div>
		);
	}

	// ---- custom font
	const [customOpen, setCustomOpen] = createSignal(st().font === "custom");
	const [draft, setDraft] = createSignal(st().customFont);
	const [installed] = createResource(() => customOpen() || undefined, () => installedFonts());
	const known = createMemo(() => new Set((installed() ?? []).map((f) => f.toLowerCase())));
	const matches = createMemo(() => matchFonts(installed() ?? [], draft(), 14));
	const useCustom = (name: string) => {
		const n = cleanFamily(name);
		setDraft(n);
		if (n) p.setSettings({ font: "custom", customFont: n });
	};
	const status = (): string => {
		const n = cleanFamily(draft());
		if (installed.loading) return "Looking up the fonts installed on this computer…";
		if (!n) return (installed() ?? []).length ? "Type a font name, or pick one of the fonts below." : "Type the name of a font installed on this computer.";
		if ((installed() ?? []).length && !known().has(n.toLowerCase())) return `“${n}” is not installed here: the text would fall back to the default font.`;
		if (st().font === "custom" && st().customFont === n) return `Reading in ${n}.`;
		return "Press Enter to use it.";
	};
	const inputTheme = () => ({
		appearance: pal().dark ? "dark" : "light", bg: pal().bg, text: pal().fg, textMuted: pal().muted, textFaint: pal().muted, textDim: pal().muted,
		accent: pal().cite, caret: pal().cite, fontSans: "Inter",
	});

	const pick = (id: FontKind) => { setCustomOpen(false); p.setSettings({ font: id }); };

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, paddingLeft: 14, borderBottomWidth: 1, borderColor: pal().rule, backgroundColor: pal().panel, flexShrink: 0 }}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
				{label("Font")}
				<For each={FONTS.filter((f) => f.group === "serif")}>{(f) => <FontChip label={f.label} family={f.family} on={st().font === f.id && !customOpen()} onClick={() => pick(f.id)} />}</For>
				{divider()}
				<For each={FONTS.filter((f) => f.group === "sans")}>{(f) => <FontChip label={f.label} family={f.family} on={st().font === f.id && !customOpen()} onClick={() => pick(f.id)} />}</For>
				{divider()}
				<FontChip
					label={st().customFont ? `${st().customFont}` : "Custom…"} family={st().customFont || "Inter"} muted={!st().customFont}
					on={st().font === "custom" || customOpen()}
					onClick={() => { setCustomOpen(true); setDraft(st().customFont); if (st().customFont) p.setSettings({ font: "custom" }); }}
				/>
			</div>
			<Show when={customOpen()}>
				<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: LABEL_W + 6 }}>
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
						<div style={{ display: "flex", alignItems: "center", width: 260, height: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 6, borderWidth: 1, borderColor: pal().fg, backgroundColor: pal().bg }}>
							<Icon name="type" size={13} color={pal().muted} />
							<input
								value={draft()}
								placeholder="Font name, e.g. Aptos"
								autoFocus
								onChange={(e: EventPayload) => setDraft((e as { value?: string }).value ?? "")}
								onSubmit={() => useCustom(draft())}
								style={{ flexGrow: 1, minWidth: 0, height: 26, marginLeft: 6, fontSize: 13, fontFamily: "Inter", color: pal().fg, keyboardFocusDim: false }}
								theme={inputTheme() as never}
							/>
						</div>
						<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11.5 }}>{status()}</text>
					</div>
					<Show when={matches().length}>
						<div style={{ display: "flex", flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
							<For each={matches()}>{(f) => <FontChip label={f} family={f} on={st().font === "custom" && st().customFont === f} onClick={() => useCustom(f)} />}</For>
						</div>
					</Show>
				</div>
			</Show>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
				<Stepper name="Size" value={`${st().size}px`} dec={() => p.setSettings({ size: step(st().size, -1, LIMITS.size) })} inc={() => p.setSettings({ size: step(st().size, 1, LIMITS.size) })} />
				<Stepper name="Line spacing" value={st().lineHeight.toFixed(2)} dec={() => p.setSettings({ lineHeight: step(st().lineHeight, -0.05, LIMITS.lineHeight, 2) })} inc={() => p.setSettings({ lineHeight: step(st().lineHeight, 0.05, LIMITS.lineHeight, 2) })} />
				<Stepper name="Text width" value={`${st().width}px`} dec={() => p.setSettings({ width: step(st().width, -40, LIMITS.width) })} inc={() => p.setSettings({ width: step(st().width, 40, LIMITS.width) })} />
			</div>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
				{label("Theme")}
				<For each={THEMES}>{(th) => { const c = themeColors(th.id); return <ThemeChip label={th.label} bg={c.bg} fg={c.fg} on={st().theme === th.id} onClick={() => p.setSettings({ theme: th.id })} />; }}</For>
				<Show when={st().theme === "custom"}>{(() => { const c = () => themeColors("custom", st().customBg); return <ThemeChip label="Custom" bg={c().bg} fg={c().fg} on onClick={() => {}} />; })()}</Show>
				<div style={{ flexGrow: 1 }} />
				<Chip label="Reset" onClick={() => { setCustomOpen(false); p.reset(); }} />
			</div>
		</div>
	);
}

/** The family a settings object reads in (custom font when set), for previews. */
function fontOf(s: ReadingSettings): string {
	return s.font === "custom" && s.customFont ? s.customFont : (FONTS.find((f) => f.id === s.font) ?? FONTS[0]).family;
}
