// `ui-icon`: a builtin Lucide name, a bundled file of the plugin package (an SVG is a one-colour mask in the text colour, as the
// builtin ones are; a PNG is drawn as it is), or inline SVG. `spin` turns a glyph in 30 degree steps.
import { createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Icon, iconSvg } from "../../../icons";
import { darkVariant, mimeOf, readPackageFile, toDataUrl } from "../l10n";
import type { IconRef } from "../types";
import { useRt } from "./ctx";

const decoder = new TextDecoder();
const maskable = (svg: string) => svg.replace(/currentColor/g, "#000000");
const rotate = (markup: string, deg: number) => markup.replace(/(<svg[^>]*>)([\s\S]*)<\/svg>/, `$1<g transform="rotate(${deg} 12 12)">$2</g></svg>`);

export function UiIcon(p: { icon: IconRef | undefined; size?: number; color: string; spin?: boolean }): JSX.Element {
	const rt = useRt();
	const size = () => p.size ?? 16;
	const [angle, setAngle] = createSignal(0);
	onMount(() => {
		if (!p.spin || rt.reducedMotion()) return;
		const h = setInterval(() => setAngle((a) => (a + 30) % 360), 90);
		onCleanup(() => clearInterval(h));
	});
	const bundled = createMemo(() => {
		const i = p.icon;
		if (i?.tag !== "bundled") return undefined;
		const dir = rt.dir();
		const dark = rt.mode() === "dark" ? readPackageFile(dir, darkVariant(i.val)) : undefined;
		const bytes = dark ?? readPackageFile(dir, i.val);
		if (!bytes) return undefined;
		return i.val.toLowerCase().endsWith(".svg") ? { svg: maskable(decoder.decode(bytes)) } : { url: toDataUrl(bytes, mimeOf(i.val)) };
	});
	return (
		<>
			<Show when={p.icon?.tag === "builtin"}>
				{p.spin ? (
					<svg source={rotate(iconSvg(p.icon!.val), angle())} style={{ flexShrink: 0, width: size(), height: size(), color: p.color }} />
				) : (
					<Icon name={p.icon!.val} size={size()} color={p.color} />
				)}
			</Show>
			<Show when={p.icon?.tag === "svg"}>
				<svg source={p.spin ? rotate(maskable(p.icon!.val), angle()) : maskable(p.icon!.val)} style={{ flexShrink: 0, width: size(), height: size(), color: p.color }} />
			</Show>
			<Show when={p.icon?.tag === "bundled"}>
				<Show when={bundled()} fallback={<Icon name="image-off" size={size()} color={p.color} />}>
					{(b) =>
						"svg" in b() ? (
							<svg source={(b() as { svg: string }).svg} style={{ flexShrink: 0, width: size(), height: size(), color: p.color }} />
						) : (
							<img src={(b() as { url: string }).url} style={{ flexShrink: 0, width: size(), height: size() }} />
						)
					}
				</Show>
			</Show>
		</>
	);
}
