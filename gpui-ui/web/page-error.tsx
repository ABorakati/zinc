// What the plain web page shows in place of the app when its library cannot start (web/browser-db/page-library.ts rejects: Zinc is open in
// another tab, the database worker stopped, the browser has no OPFS). Same look as the browser library's welcome screen: the canvas,
// one card, text from the theme.
import type { JSX } from "solid-js";
import type { Mode, Style } from "../src/contracts";
import { textStyle, tw } from "../src/theme";

export function PageError(p: { message: string; mode: Mode }): JSX.Element {
	const t = (cls: string): Style => tw(cls, p.mode);
	const tx = (cls: string): Style => textStyle(cls, p.mode);
	return (
		<div style={{ ...t("flex items-center justify-center bg-canvas p-6"), width: "100%", height: "100%" }}>
			<div style={{ ...t("flex flex-col gap-3 rounded-[14px] bg-background shadow-raised p-8"), width: 520, maxWidth: "100%" }}>
				<text style={tx("text-lg font-semibold text-foreground")}>Zinc cannot open its library here</text>
				<text style={tx("text-sm text-muted-foreground")}>{p.message}</text>
			</div>
		</div>
	);
}
