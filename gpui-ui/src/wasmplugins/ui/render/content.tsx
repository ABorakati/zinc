// Content kinds: text, link, image, icon, progress, badge, callout, rich-text, code, skeleton.
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { api } from "../../../api";
import { Icon } from "../../../icons";
import { clipboard, confirm } from "../../../ui";
import { t, tok, tx } from "../../../ui/core";
import { withAlpha } from "../../../theme";
import { P } from "../controller";
import { htmlToMarkdown, mdEscape } from "../markup";
import { mimeOf, readPackageFile, svgUrl, toDataUrl } from "../l10n";
import { resolveColor } from "../colors";
import { FONT_FAMILY, FONT_SIZE, textStyleOf, type TextProps } from "../styleMap";
import type { Color, LinkTarget, UiText } from "../types";
import { useRt, type KindComponent, type KindProps } from "./ctx";
import { UiIcon } from "./icons";
import { Children } from "./node";

type TextRun = { text: UiText; bold: boolean; italic: boolean; underline: boolean; strike: boolean; mono: boolean; color?: Color; size?: string; link?: LinkTarget };

const TEXT_KINDS: Record<string, { size: number; weight?: number; family?: string; color?: string }> = {
	body: { size: 13 },
	label: { size: 13, weight: 500 },
	caption: { size: 11.5, color: "muted-foreground" },
	heading1: { size: 22, weight: 600, family: "Source Serif 4" },
	heading2: { size: 18, weight: 600 },
	heading3: { size: 15, weight: 600 },
	title: { size: 18, weight: 600, family: "Source Serif 4" },
	mono: { size: 12, family: "Cascadia Mono" },
};

/** Open a link: a url (http, https, zotero: only; anything else after the user agrees) or a plugin handler. */
export function useOpenLink() {
	const rt = useRt();
	return async (target: LinkTarget, nodeKey?: string) => {
		if (target.tag === "handler") return void rt.ctl.fireRaw(target.val, "press", P.none, nodeKey);
		const url = target.val;
		if (!/^(https?|zotero):/i.test(url)) {
			const ok = await confirm({ title: "Open this link?", body: url, confirmLabel: "Open" });
			if (!ok) return;
		}
		try {
			await api.openUrl(url);
		} catch {
			/* the core refused or is not there */
		}
	};
}

// ---------------------------------------------------------------------------------------------------- text

function mdOfRuns(runs: TextRun[], txt: (t: UiText) => string): string {
	return runs
		.map((r) => {
			let s = r.mono ? "`" + txt(r.text).replace(/`/g, "'") + "`" : mdEscape(txt(r.text));
			if (!s.trim()) return s;
			if (r.bold) s = `**${s}**`;
			if (r.italic) s = `*${s}*`;
			if (r.strike) s = `~~${s}~~`;
			if (r.link) s = `[${s}](${r.link.tag === "url" ? r.link.val : "zinc-handler:" + encodeURIComponent(r.link.val)})`;
			return s;
		})
		.join("");
}

export function markdownTheme(rt: ReturnType<typeof useRt>, t: TextProps, base = 13) {
	const mode = rt.mode();
	return {
		appearance: mode,
		bg: tok("background"),
		text: t.color ?? tok("foreground"),
		textMuted: tok("muted-foreground"),
		textFaint: withAlpha(tok("muted-foreground"), 0.7),
		textDim: withAlpha(tok("muted-foreground"), 0.7),
		accent: tok("primary"),
		link: tok("primary"),
		fontSans: t.fontFamily ?? "Inter",
		metrics: { mdTextSize: t.fontSize ?? base, mdLineHeight: Math.round((t.fontSize ?? base) * (t.lineHeight ?? 1.5)) },
	};
}

const Text: KindComponent = (p) => {
	const rt = useRt();
	const open = useOpenLink();
	const spec = () => p.node.kind.val ?? {};
	const runs = () => (spec().runs as TextRun[]) ?? [];
	const kind = () => TEXT_KINDS[spec().kind ?? "body"] ?? TEXT_KINDS.body!;
	const base = () => ({ fontSize: kind().size, fontWeight: kind().weight, fontFamily: kind().family, color: tok(kind().color ?? "foreground") });
	const style = (r?: TextRun): Record<string, unknown> => {
		const t = { ...p.text() };
		if (r?.size) t.fontSize = FONT_SIZE[r.size];
		if (r?.color) t.color = resolveColor(r.color, rt.mode());
		if (r?.bold) t.fontWeight = 700;
		if (r?.mono) t.fontFamily = FONT_FAMILY.mono;
		if (r?.underline) t.underline = true;
		if (r?.strike) t.strike = true;
		return textStyleOf(t, base());
	};
	const uniform = () => {
		const r = runs();
		if (r.length <= 1) return true;
		const f = r[0]!;
		return r.every((x) => x.bold === f.bold && x.mono === f.mono && x.underline === f.underline && x.strike === f.strike && x.italic === f.italic && !x.link && !x.color && !x.size);
	};
	const hasLink = () => runs().some((r) => r.link);
	const needsMd = () => !uniform() && !runs().some((r) => r.color || r.size) || hasLink() && !runs().some((r) => r.color || r.size) || runs().some((r) => r.italic) && !runs().some((r) => r.color || r.size);
	const wrapStyle = (): Record<string, unknown> => ({ ...p.box(), ...(spec().selectable === false ? { userSelect: "none" } : {}) });
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...wrapStyle() }}>
			<Switch>
				<Match when={needsMd()}>
					<markdown
						source={mdOfRuns(runs(), (x) => rt.txt(x))}
						theme={markdownTheme(rt, p.text(), kind().size)}
						onLinkClick={(e: EventPayload) => {
							const v = e.value ?? "";
							void open(v.startsWith("zinc-handler:") ? { tag: "handler", val: decodeURIComponent(v.slice(13)) } : { tag: "url", val: v }, p.node.props.key);
						}}
						style={{ width: "100%" }}
					/>
				</Match>
				<Match when={uniform()}>
					<text style={style(runs()[0])}>{runs().map((r) => rt.txt(r.text)).join("")}</text>
				</Match>
				<Match when={true}>
					<div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "baseline" }}>
						<For each={runs().flatMap((r) => (rt.txt(r.text).match(/\S+\s*|\s+/g) ?? []).map((w) => ({ w, r })))}>
							{(tok_) => (
								<text
									onClick={tok_.r.link ? () => void open(tok_.r.link!, p.node.props.key) : undefined}
									style={{ ...style(tok_.r), whiteSpace: "nowrap", ...(tok_.r.link ? { cursor: "pointer", textDecoration: "underline" } : {}) }}
								>
									{tok_.w}
								</text>
							)}
						</For>
					</div>
				</Match>
			</Switch>
		</div>
	);
};
const Link: KindComponent = (p) => {
	const rt = useRt();
	const open = useOpenLink();
	const spec = () => p.node.kind.val ?? {};
	const [hot, setHot] = createSignal(false);
	return (
		<div
			{...p.handlers}
			role="link"
			onMouseEnter={() => setHot(true)}
			onMouseLeave={() => setHot(false)}
			onClick={(e: EventPayload) => {
				(p.handlers.onClick as (e: EventPayload) => void)?.(e);
				void open(spec().target as LinkTarget, p.node.props.key);
			}}
			style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, cursor: "pointer", alignSelf: "flex-start", ...p.box() }}
		>
			<Show when={spec().icon}>
				<UiIcon icon={spec().icon} size={14} color={tok("primary")} />
			</Show>
			<text style={{ ...textStyleOf(p.text(), { fontSize: 13, color: tok("primary") }), color: tok(hot() ? "primary-deep" : "primary"), textDecoration: hot() ? "underline" : "none", whiteSpace: "nowrap" }}>
				{rt.txt(spec().label)}
			</text>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- image, icon

const MAX_IMAGE = 4 * 1024 * 1024;

/** A data URL (or placeholder reason) for an `image-source`. */
export function imageUrl(rt: ReturnType<typeof useRt>, src: { tag: string; val: any } | undefined): { url?: string; note?: string } {
	if (!src) return { note: "no image" };
	switch (src.tag) {
		case "asset": {
			const bytes = readPackageFile(rt.dir(), src.val);
			return bytes ? { url: toDataUrl(bytes, mimeOf(src.val)) } : { note: `missing asset ${src.val}` };
		}
		case "png":
		case "jpeg": {
			const b = src.val as Uint8Array;
			return b.length > MAX_IMAGE ? { note: "image over 4 MB" } : { url: toDataUrl(b, src.tag === "png" ? "image/png" : "image/jpeg") };
		}
		case "svg":
			return { url: svgUrl(src.val) };
		case "attachment":
			return { note: `attachment preview ${src.val}` };
	}
	return { note: "unknown image source" };
}

const FIT: Record<string, string> = { contain: "contain", cover: "cover", fill: "fill", none: "none" };

const Image: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const img = createMemo(() => imageUrl(rt, spec().source));
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<Show
				when={img().url}
				fallback={
					<div style={{ ...t("flex items-center gap-2 rounded-md border border-dashed p-3"), width: "100%" }}>
						<Icon name="image-off" size={16} color={tok("muted-foreground")} />
						<text style={tx("text-xs text-muted-foreground")}>{img().note ?? ""}</text>
					</div>
				}
			>
				<img src={img().url!} alt={rt.txt(spec().alt)} objectFit={FIT[spec().fit ?? "contain"] as "contain"} style={{ width: "100%", height: "100%", flexGrow: 1, minHeight: 0 }} />
			</Show>
		</div>
	);
};

const IconK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	return (
		<div {...p.handlers} style={{ display: "flex", flexShrink: 0, alignSelf: "flex-start", ...p.box() }}>
			<UiIcon icon={spec().icon} size={spec().size ?? 16} color={resolveColor(spec().color, rt.mode()) ?? p.text().color ?? tok("foreground")} spin={!!spec().spin} />
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- progress, badge, callout, skeleton

const arc = (cx: number, cy: number, r: number, frac: number) => {
	const a = Math.min(0.9999, Math.max(0.0001, frac)) * Math.PI * 2 - Math.PI / 2;
	const x = cx + r * Math.cos(a),
		y = cy + r * Math.sin(a);
	return `M ${cx} ${cy - r} A ${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
};

const Progress: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const value = () => spec().value as number | undefined;
	const [phase, setPhase] = createSignal(0);
	onMount(() => {
		if (value() !== undefined || rt.reducedMotion()) return;
		const h = setInterval(() => setPhase((x) => (x + 0.05) % 1), 60);
		onCleanup(() => clearInterval(h));
	});
	const ringSvg = (frac: number, color = "#000") =>
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"><path d="${arc(12, 12, 9, frac)}"/></svg>`;
	const trackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3"><circle cx="12" cy="12" r="9"/></svg>`;
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, ...p.box() }} role="progressbar">
			<Switch>
				<Match when={spec().look === "bar"}>
					<div style={{ flexGrow: 1, height: 6, borderRadius: 3, backgroundColor: tok("secondary"), overflow: "hidden", display: "flex" }}>
						<Show
							when={value() !== undefined}
							fallback={
								<>
									<div style={{ flexGrow: phase() * 70 + 0.001, flexBasis: 0 }} />
									<div style={{ flexGrow: 30, flexBasis: 0, height: 6, borderRadius: 3, backgroundColor: tok("primary") }} />
									<div style={{ flexGrow: (1 - phase()) * 70 + 0.001, flexBasis: 0 }} />
								</>
							}
						>
							<div style={{ width: `${Math.round(Math.min(1, Math.max(0, value()!)) * 100)}%`, height: 6, borderRadius: 3, backgroundColor: tok("primary") }} />
						</Show>
					</div>
				</Match>
				<Match when={spec().look === "ring"}>
					<div style={{ position: "relative", width: 22, height: 22, flexShrink: 0 }}>
						<svg source={trackSvg} style={{ position: "absolute", top: 0, left: 0, width: 22, height: 22, color: tok("secondary") }} />
						<svg source={ringSvg(value() ?? 0.25)} style={{ position: "absolute", top: 0, left: 0, width: 22, height: 22, color: tok("primary") }} />
					</div>
				</Match>
				<Match when={true}>
					<UiIcon icon={{ tag: "builtin", val: "loader-circle" }} size={16} color={tok("primary")} spin />
				</Match>
			</Switch>
			<Show when={spec().label}>
				<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{rt.txt(spec().label)}</text>
			</Show>
		</div>
	);
};

export const toneColors = (tone: string | undefined): { bg: string; fg: string } => {
	switch (tone) {
		case "success":
			return { bg: tok("success"), fg: tok("success-foreground") };
		case "warning":
			return { bg: tok("warning"), fg: tok("warning-foreground") };
		case "error":
			return { bg: tok("error"), fg: tok("error-foreground") };
		case "info":
			return { bg: tok("primary-soft"), fg: tok("primary-deep") };
		default:
			return { bg: tok("secondary"), fg: tok("secondary-foreground") };
	}
};
const toneIcon: Record<string, string> = { info: "info", success: "circle-check", warning: "triangle-alert", error: "circle-x", neutral: "info" };

const Badge: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const colors = () => {
		const c = toneColors(spec().tone);
		const own = resolveColor(spec().color, rt.mode());
		return own ? { bg: withAlpha(own, 0.16), fg: own } : c;
	};
	return (
		<div {...p.handlers} style={{ ...t("flex h-5 flex-none items-center gap-1 rounded-full px-2"), alignSelf: "flex-start", backgroundColor: colors().bg, ...p.box() }}>
			<Show when={spec().icon}>
				<UiIcon icon={spec().icon} size={12} color={colors().fg} />
			</Show>
			<text style={{ ...tx("text-[11px] font-medium"), color: colors().fg, whiteSpace: "nowrap" }}>{rt.txt(spec().label)}</text>
			<Show when={spec().removable}>
				<div onClick={() => rt.ctl.fire(p.node, "close")} style={{ cursor: "pointer", display: "flex" }}>
					<Icon name="x" size={12} color={colors().fg} />
				</div>
			</Show>
		</div>
	);
};

const Callout: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const c = () => toneColors(spec().tone);
	return (
		<div role="alert" {...p.handlers} style={{ ...t("flex items-start gap-2 rounded-md border p-2.5"), backgroundColor: c().bg, borderColor: withAlpha(c().fg, 0.25), ...p.box() }}>
			<UiIcon icon={spec().icon ?? { tag: "builtin", val: toneIcon[spec().tone ?? "info"] ?? "info" }} size={16} color={c().fg} />
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 }}>
				<Show when={spec().title}>
					<text style={{ ...tx("text-[13px] font-semibold"), color: c().fg }}>{rt.txt(spec().title)}</text>
				</Show>
				<Show when={spec().message}>
					<text style={{ ...tx("text-[13px]"), color: c().fg }}>{rt.txt(spec().message)}</text>
				</Show>
				<Children node={p.node} />
			</div>
			<Show when={spec().dismissible}>
				<div role="button" aria-label="Dismiss" onClick={() => rt.ctl.fire(p.node, "close")} style={{ cursor: "pointer", display: "flex" }}>
					<Icon name="x" size={14} color={c().fg} />
				</div>
			</Show>
		</div>
	);
};

const Skeleton: KindComponent = (p) => {
	const spec = () => p.node.kind.val ?? {};
	const dimOf = (d: any, dflt: number) => (!d ? dflt : d.tag === "px" ? d.val : d.tag === "step" ? d.val * 4 : d.tag === "percent" ? `${d.val}%` : dflt);
	return (
		<div {...p.handlers} style={{ width: dimOf(spec().width, 120), height: dimOf(spec().height, 14), borderRadius: 4, backgroundColor: withAlpha(tok("foreground"), 0.08), flexShrink: 0, ...p.box() }} />
	);
};

// ---------------------------------------------------------------------------------------------------- rich text, code

const RichText: KindComponent = (p) => {
	const rt = useRt();
	const open = useOpenLink();
	const spec = () => p.node.kind.val ?? {};
	const source = createMemo(() => (spec().format === "html-subset" ? htmlToMarkdown(spec().source ?? "") : (spec().source ?? "")));
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<markdown
				source={source()}
				theme={markdownTheme(rt, p.text())}
				onLinkClick={(e: EventPayload) => {
					const url = e.value ?? "";
					if (/^(https?|zotero):/i.test(url)) return void open({ tag: "url", val: url }, p.node.props.key);
					const h = spec().linkHandler as string | undefined;
					if (h) rt.ctl.fireRaw(h, "press", P.message(JSON.stringify({ url })), p.node.props.key);
				}}
				style={{ width: "100%" }}
			/>
		</div>
	);
};

const Code: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [copied, setCopied] = createSignal(false);
	const theme = () => ({ appearance: rt.mode(), bg: tok("muted"), text: tok("foreground"), fontMono: "Cascadia Mono" });
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<div style={{ ...t("flex flex-col rounded-md border bg-muted"), position: "relative", overflow: "hidden" }}>
				<code
					code={spec().source ?? ""}
					language={spec().language}
					showLineNumbers={!!spec().lineNumbers}
					theme={theme()}
					style={{ fontFamily: "Cascadia Mono", fontSize: 12, padding: 10, backgroundColor: tok("muted"), color: tok("foreground") }}
				/>
				<Show when={spec().copyButton}>
					<div
						role="button"
						aria-label="Copy"
						onClick={() => {
							void clipboard.writeText(spec().source ?? "");
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						}}
						style={{ ...t("flex h-6 items-center gap-1 rounded-md border bg-background px-1.5"), position: "absolute", top: 6, right: 6, cursor: "pointer" }}
					>
						<Icon name={copied() ? "check" : "copy"} size={12} color={tok("muted-foreground")} />
					</div>
				</Show>
			</div>
		</div>
	);
};

export const content: Record<string, KindComponent> = {
	text: Text,
	link: Link,
	image: Image,
	icon: IconK,
	progress: Progress,
	badge: Badge,
	callout: Callout,
	"rich-text": RichText,
	code: Code,
	skeleton: Skeleton,
};
export type { KindProps };
