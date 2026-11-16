// The update prompts, on the app's own toast and dialog helpers: a non-blocking toast "Zinc <ver> is available" with What's new /
// Install on exit / Install now, and the "What's new" dialog (release notes + the same choices). Never modal on its own.
import { For, Show, type JSX } from "solid-js";
import type { Manifest } from "../../../core/src/update/manifest";
import { displayVersion } from "../../../core/src/update/version";
import { Footer, Line, Scroll, Txt } from "../features/kit";
import { Button, openDialog, toast } from "../ui";
import { notesToLines } from "./notes";

export interface UpdateActions {
	installNow(): void;
	installOnExit(): void;
}

const when = (m: Manifest) => {
	const d = new Date(m.releasedAt);
	return Number.isNaN(d.getTime()) ? "" : `Released ${d.toLocaleDateString()}`;
};

/** "Zinc 0.2.0 is available" (or "is ready to install" once downloaded). Stays ~20 s, pauses while the pointer is over it. */
export function showUpdateToast(m: Manifest, a: UpdateActions, o: { ready?: boolean } = {}): void {
	toast(`Zinc ${displayVersion(m.version)} ${o.ready ? "is ready to install" : "is available"}`, {
		id: "update-available",
		description: when(m) || undefined,
		actions: [
			{ label: "What’s new", run: () => openWhatsNew(m, a) },
			{ label: "Install on exit", run: a.installOnExit },
			{ label: "Install now", run: a.installNow },
		],
		durationMs: 20000,
	});
}

function WhatsNew(p: { m: Manifest; a: UpdateActions; close: () => void; manualOnly?: boolean }): JSX.Element {
	const lines = notesToLines(p.m.notes);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
			<Line class="text-xs text-muted-foreground">
				{[when(p.m), `${(p.m.size / 1048576).toFixed(1)} MB`].filter(Boolean).join(" · ")}
			</Line>
			<Scroll height={260} border style={{ padding: 12, gap: 4 }}>
				<Show when={lines.length} fallback={<Txt class="text-sm text-muted-foreground">No release notes.</Txt>}>
					<For each={lines}>
						{(l) => (
							<Txt
								class={`text-sm ${l.startsWith("•") ? "text-foreground" : "text-foreground font-medium"}`}
								style={{ whiteSpace: "normal", flexShrink: 0 }}
							>
								{l === "" ? " " : l}
							</Txt>
						)}
					</For>
				</Show>
			</Scroll>
			<Show when={p.manualOnly}>
				<Line class="text-xs text-destructive">
					This version cannot be installed over the one you have; download the installer from the project page.
				</Line>
			</Show>
			<Footer>
				<Button variant="ghost" size="sm" onClick={p.close}>
					Later
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={p.manualOnly}
					onClick={() => {
						p.close();
						p.a.installOnExit();
					}}
				>
					Install on exit
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={p.manualOnly}
					onClick={() => {
						p.close();
						p.a.installNow();
					}}
				>
					Install now
				</Button>
			</Footer>
		</div>
	);
}

let open = false;
export function openWhatsNew(m: Manifest, a: UpdateActions, o: { manualOnly?: boolean } = {}): void {
	if (open) return;
	open = true;
	void openDialog<void>((close) => <WhatsNew m={m} a={a} close={() => close()} manualOnly={o.manualOnly} />, {
		title: `Zinc ${displayVersion(m.version)}`,
		width: 520,
	}).finally(() => {
		open = false;
	});
}
