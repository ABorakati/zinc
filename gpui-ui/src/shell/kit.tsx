// Small building blocks shared by the shell's screens (Settings, the sync popover): themed style helpers and a few layout parts.
// Class strings are the web UI's; every <text> gets a colour through textStyle().
import type { JSX } from "solid-js";
import type { Mode, Style } from "../contracts";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";

export const mode = (): Mode => store.mode();
export const tok = (name: string): string => tokens[mode()][name] ?? "#888";
export const t = (cls: string): Style => tw(cls, mode());
export const tx = (cls: string): Style => textStyle(cls, mode());

/** Collapse a box out of the layout while keeping its subtree mounted (GPUIX has no display:none that does). */
export const HIDDEN: Style = {
	display: "none", visibility: "hidden", width: 0, height: 0, flexGrow: 0, flexShrink: 1, overflow: "hidden",
	padding: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0,
};

/** One text node. `cls` is Tailwind classes (text-xs text-muted-foreground ...); a single string child, so it is one node. */
export function Txt(p: { cls?: string; children: string | (() => string); style?: Style; wrap?: boolean }): JSX.Element {
	return (
		<text style={{ ...tx(p.cls ?? ""), ...(p.wrap === false ? { whiteSpace: "nowrap" } : {}), ...p.style }}>
			{typeof p.children === "function" ? p.children() : p.children}
		</text>
	);
}

/** A tinted note box ("warn" amber, "ok" muted, "error" red). */
export function Note(p: { tone?: "warn" | "ok" | "error"; children: JSX.Element; style?: Style }): JSX.Element {
	const bg = () => {
		const tone = p.tone ?? "ok";
		return tone === "warn" ? "bg-warning" : tone === "error" ? "bg-destructive/10" : "bg-muted";
	};
	return <div style={{ ...t(`flex flex-col gap-1 rounded-md p-2.5 ${bg()}`), maxWidth: 560, ...p.style }}>{p.children}</div>;
}

export const NoteText = (p: { tone?: "warn" | "ok" | "error"; children: string; mono?: boolean }): JSX.Element => (
	<Txt
		cls={`text-xs ${p.tone === "warn" ? "text-warning-foreground" : p.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
		style={p.mono ? { fontFamily: "Consolas" } : undefined}
	>
		{p.children}
	</Txt>
);

export const Divider = (): JSX.Element => <div style={{ ...t("bg-border"), height: 1, width: "100%", flexShrink: 0 }} />;
