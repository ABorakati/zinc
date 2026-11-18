// Draws a ViewController: the runtime context, the root node and a banner when the plugin is not answering.
import { createMemo, onCleanup, Show, type JSX } from "solid-js";
import { useGpuix, type HostElement } from "@gpuix/solid";
import type { Style } from "../../contracts";
import { Icon } from "../../icons";
import { Button } from "../../ui";
import { mode, t, tok, tx } from "../../ui/core";
import type { ViewController } from "./controller";
import { textOf } from "./l10n";
import { NodeView } from "./render/node";
import { RuntimeCtx, type ViewRuntime } from "./render/ctx";
import type { UiText } from "./types";

export interface ControllerViewProps {
	controller: ViewController;
	style?: Style;
	/** Reduced motion (spinners hold still). */
	reducedMotion?: boolean;
}

/** The plugin's grants as the supervisor reports them (live: the supervisor record is read on every call). */
const grantsOf = (ctl: ViewController) => ctl.sup.get?.(ctl.pluginId)?.grants;

export function ControllerView(p: ControllerViewProps): JSX.Element {
	const ctl = p.controller;
	const g = useGpuix();
	const rt: ViewRuntime = {
		ctl,
		pluginId: ctl.pluginId,
		mode,
		txt: (x: UiText | undefined) => textOf(x, ctl.pluginId),
		dir: () => ctl.sup.get?.(ctl.pluginId)?.dir,
		has: (perm) => grantsOf(ctl)?.capabilities.includes(perm) ?? false,
		netHosts: () => grantsOf(ctl)?.netHosts ?? [],
		reducedMotion: () => !!p.reducedMotion,
	};
	ctl.hooks = {
		focus: (el) => g?.renderer.focusElement?.((el as HostElement).id),
		scrollTo: (el) => g?.renderer.scrollIntoView?.((el as HostElement).id),
	};
	onCleanup(() => {
		ctl.hooks = {};
	});
	const root = () => ctl.state.root;
	const problem = createMemo(() => (ctl.state.status === "unresponsive" ? "unresponsive" : ctl.state.status === "error" ? "error" : undefined));
	return (
		<RuntimeCtx.Provider value={rt}>
			<div style={{ display: "flex", flexDirection: "column", width: "100%", position: "relative", ...p.style }}>
				<Show when={root()} fallback={<Skeleton status={ctl.state.status} />}>
					{(r) => (
						<div style={{ display: "flex", flexDirection: "column", width: "100%", flexGrow: 1, minHeight: 0, opacity: problem() === "unresponsive" ? 0.5 : 1 }}>
							<NodeView node={r()} />
						</div>
					)}
				</Show>
				<Show when={problem() || ctl.state.message}>
					<div style={{ ...t("flex items-start gap-2 rounded-md border p-2"), marginTop: 6, backgroundColor: tok(problem() ? "warning" : "secondary") }}>
						<Icon name={problem() === "unresponsive" ? "plug-zap" : "triangle-alert"} size={14} color={tok("warning-foreground")} style={{ marginTop: 1 }} />
						<div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 1, minWidth: 0 }}>
							<Show when={problem() === "unresponsive"}>
								<text style={{ ...tx("text-xs font-semibold"), color: tok("warning-foreground") }}>Plugin not responding</text>
							</Show>
							<text style={{ ...tx("text-xs"), color: tok(problem() ? "warning-foreground" : "muted-foreground") }}>{ctl.state.message ?? ""}</text>
						</div>
						<Show when={problem() === "unresponsive"}>
							<Button size="sm" variant="outline" onClick={() => void ctl.remount()}>
								Retry
							</Button>
						</Show>
					</div>
				</Show>
			</div>
		</RuntimeCtx.Provider>
	);
}

function Skeleton(p: { status: string }): JSX.Element {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4 }}>
			<div style={{ height: 10, width: "40%", borderRadius: 4, backgroundColor: tok("muted") }} />
			<Show when={p.status === "mounting" || p.status === "idle"}>
				<div style={{ height: 10, width: "70%", borderRadius: 4, backgroundColor: tok("muted") }} />
			</Show>
		</div>
	);
}
