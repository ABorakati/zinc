// Headless screenshot of theme.ts / fonts.ts / icons.tsx: token swatches, tw()-styled boxes, both fonts, icons; dark | light.
// bun scripts/shot-theme.tsx [out.png]
import { For } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import type { Mode } from "../src/contracts";
import { registerFonts, fontFamily } from "../src/fonts";
import { Icon } from "../src/icons";
import { textStyle, tokens, tw, twUnknown } from "../src/theme";

const out =
	process.argv[2] ??
	"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots/theme.png";

const SWATCHES = [
	"background",
	"foreground",
	"canvas",
	"topbar",
	"card",
	"muted",
	"muted-foreground",
	"popover",
	"border",
	"border-soft",
	"input",
	"primary",
	"primary-foreground",
	"primary-soft",
	"primary-tint",
	"primary-line",
	"primary-deep",
	"secondary",
	"accent",
	"destructive",
	"success",
	"success-foreground",
	"warning",
	"warning-foreground",
	"error",
	"error-foreground",
	"journal",
];
const ICONS = [
	"folder",
	"folder-open",
	"chevron-right",
	"file-text",
	"copy",
	"search",
	"layout-list",
	"table-2",
	"panel-left",
	"settings",
	"plus",
	"wrench",
	"refresh-cw",
	"star",
];

function T(p: { m: Mode; c?: string; children: string }) {
	return <text style={textStyle(p.c, p.m)}>{p.children}</text>;
}

function Section(p: { m: Mode; title: string; children: unknown }) {
	return (
		<div style={{ ...tw("flex flex-col gap-1.5", p.m) }}>
			<text style={textStyle("text-[10px] font-semibold text-muted-foreground tracking-wide", p.m)}>{p.title.toUpperCase()}</text>
			{p.children as never}
		</div>
	);
}

function Panel(p: { m: Mode }) {
	const m = p.m;
	const tk = tokens[m];
	return (
		<div style={{ ...tw("flex flex-col gap-4 p-4 bg-canvas", m), width: "50%", height: "100%" }}>
			<T m={m} c="text-base font-semibold">{`Theme: ${m}`}</T>

			<Section m={m} title="Tokens">
				<div style={tw("flex flex-wrap gap-1.5", m)}>
					<For each={SWATCHES}>
						{(k) => (
							<div style={{ ...tw("flex flex-col gap-1 w-[78px]", m) }}>
								<div
									style={{
										height: 26,
										borderRadius: 6,
										backgroundColor: tk[k],
										borderWidth: 1,
										borderColor: tk["border"],
									}}
								/>
								<text style={textStyle("text-[9px] text-muted-foreground truncate", m)}>{k}</text>
							</div>
						)}
					</For>
				</div>
			</Section>

			<Section m={m} title="tw() boxes">
				<div style={tw("flex items-center gap-2", m)}>
					<div style={tw("flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-primary hover:bg-primary/90", m)}>
						<Icon name="plus" size={14} color={tk["primary-foreground"]} />
						<text style={textStyle("text-xs font-medium text-primary-foreground", m)}>Add item</text>
					</div>
					<div style={tw("flex items-center gap-1.5 h-7 px-2.5 rounded-md border bg-background hover:bg-accent", m)}>
						<Icon name="refresh-cw" size={14} color={tk["muted-foreground"]} />
						<text style={textStyle("text-xs text-foreground", m)}>Sync</text>
					</div>
					<div style={tw("flex items-center h-7 px-2.5 rounded-full bg-primary/10", m)}>
						<text style={textStyle("text-xs font-semibold text-primary", m)}>12 items</text>
					</div>
					<div style={tw("flex items-center h-[26px] px-2.5 rounded-lg bg-background shadow-pill", m)}>
						<text style={textStyle("text-xs font-semibold text-primary-deep", m)}>Selected pill</text>
					</div>
				</div>
				<div style={tw("flex gap-2", m)}>
					<div style={{ ...tw("flex flex-col gap-1 p-3 rounded-[10px] bg-background shadow-raised w-52", m) }}>
						<text style={textStyle("font-title text-[15.5px] font-semibold", m)}>Raised card with serif title</text>
						<text style={textStyle("text-xs text-muted-foreground", m)}>Smith J, Doe A, 2024</text>
					</div>
					<div style={tw("flex flex-col gap-1 p-3 rounded-lg border border-border-soft bg-card w-44", m)}>
						<text style={textStyle("text-sm font-medium", m)}>Bordered card</text>
						<text style={textStyle("text-[11px] text-muted-foreground", m)}>border-border-soft</text>
					</div>
					<div style={tw("flex items-center justify-center px-3 rounded-md bg-destructive text-destructive-foreground h-12", m)}>
						<text style={textStyle("text-xs font-medium text-destructive-foreground", m)}>Destructive</text>
					</div>
				</div>
			</Section>

			<Section m={m} title={`Fonts: ${fontFamily.sans} / ${fontFamily.title}`}>
				<div style={tw("flex flex-col gap-0.5", m)}>
					<For each={[400, 500, 600, 700]}>
						{(w) => (
							<text
								style={{ ...textStyle("text-[13px]", m), fontWeight: w }}
							>{`Inter ${w}: The quick brown fox jumps over 0123456789 (Glioma, 2.5%)`}</text>
						)}
					</For>
					<text style={textStyle("text-[11px] text-muted-foreground", m)}>11px text-[11px] label</text>
					<text style={textStyle("text-xs", m)}>12px text-xs</text>
					<text style={textStyle("text-sm", m)}>14px text-sm</text>
					<text style={textStyle("font-title text-[15.5px] font-semibold", m)}>
						Source Serif 4 600 title at 15.5px, Immunotherapy outcomes
					</text>
					<text style={textStyle("font-title text-lg font-medium", m)}>Source Serif 4 500 at 18px: year heading 2024</text>
					<text style={{ ...textStyle("text-[13px]", m), fontFamily: "Manrope", fontWeight: 600 }}>
						Manrope 600 13px (fallback font stack)
					</text>
				</div>
			</Section>

			<Section m={m} title="Icons (lucide)">
				<div style={tw("flex flex-wrap gap-3 items-center", m)}>
					<For each={ICONS}>{(n) => <Icon name={n} size={16} color={tk["foreground"]} />}</For>
				</div>
				<div style={tw("flex gap-3 items-center", m)}>
					<Icon name="folder" size={14} color={tk["muted-foreground"]} />
					<Icon name="chevron-right" size={12} color={tk["muted-foreground"]} strokeWidth={2.5} />
					<Icon name="file-text" size={18} color={tk["primary"]} />
					<Icon name="star" size={22} color="#f59e0b" />
					<Icon name="settings" size={14} color={tk["destructive"]} />
				</div>
			</Section>
		</div>
	);
}

const t = createTestRoot({ width: 1440, height: 880 });
registerFonts(t.renderer as never);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<Panel m="dark" />
		<Panel m="light" />
	</div>
));
t.renderer.captureScreenshot(out);
console.log("wrote", out);
const unk = twUnknown();
if (unk.length) console.log("unknown classes:", unk.join(" "));
t.unmount();
