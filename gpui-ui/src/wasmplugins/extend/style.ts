// Colours and text styles of registrations as the app's style values.
import type { Style } from "../../contracts";
import { store } from "../../store";
import { tokens } from "../../theme";
import type { Cell, Color, Opt } from "./wit";

const hex8 = (n: number): string => {
	const v = n >>> 0;
	const r = (v >>> 24) & 0xff,
		g = (v >>> 16) & 0xff,
		b = (v >>> 8) & 0xff,
		a = v & 0xff;
	const h = (x: number) => x.toString(16).padStart(2, "0");
	return a === 0xff ? `#${h(r)}${h(g)}${h(b)}` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
};

/** A `types.color` as a CSS colour string for the current mode, or undefined. `rgba` is 0xRRGGBBAA. */
export function colorOf(c: Opt<Color>): string | undefined {
	if (!c) return undefined;
	const mode = store.mode();
	switch (c.tag) {
		case "token":
			return tokens[mode][c.val];
		case "token-alpha": {
			const base = tokens[mode][c.val.token];
			if (!base) return undefined;
			const m = /^#([0-9a-f]{6})$/i.exec(base);
			if (!m) return base;
			const a = Math.round(Math.max(0, Math.min(255, c.val.alpha)));
			return `#${m[1]}${a.toString(16).padStart(2, "0")}`;
		}
		case "rgba":
			return hex8(c.val);
		case "themed":
			return hex8(mode === "dark" ? c.val.dark : c.val.light);
	}
}

/** `text-style` as GPUIX text style keys. */
export function textStyleOf(s: Cell["style"]): Style {
	switch (s) {
		case "bold":
			return { fontWeight: 600 };
		case "italic":
			return { fontStyle: "italic" };
		case "strikethrough":
			return { textDecoration: "line-through" };
		case "muted":
			return { opacity: 0.6 };
		default:
			return {};
	}
}
