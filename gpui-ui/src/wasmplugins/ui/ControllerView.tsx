// Draws a ViewController: the runtime context, the root node and a banner when the plugin is not answering.
import { createEffect, createMemo, ErrorBoundary, on, onCleanup, Show, type JSX } from "solid-js";
import { useGpuix, type HostElement } from "@gpuix/solid";
import type { Style } from "../../contracts";
import { Icon } from "../../icons";
import { Button } from "../../ui";
import { mode, t, tok, tx } from "../../ui/core";
import { logRejection, type ViewController } from "./controller";
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
							<ErrorBoundary fallback={(err, reset) => <DrawFailed ctl={ctl} err={err} reset={reset} />}>
								<NodeView node={r()} />
							</ErrorBoundary>
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
							<Button size="sm" variant="outline" onClick={() => void ctl.remount().catch(logRejection(ctl.pluginId, "remount"))}>
								Retry
							</Button>
						</Show>
					</div>
				</Show>
			</div>
		</RuntimeCtx.Provider>
	);
}

/**
 * Data that decodes but makes a renderer throw (a malformed field the schema does not reach, a pre-built tree) is contained here: the
 * plugin surface shows a notice and the rest of the app carries on. The next tree from the plugin draws again.
 */
function DrawFailed(p: { ctl: ViewController; err: unknown; reset: () => void }): JSX.Element {
	console.error(`[plugin ${p.ctl.pluginId}] a view could not be drawn:`, p.err instanceof Error ? (p.err.stack ?? p.err.message) : p.err);
	createEffect(on(() => p.ctl.state.generation, () => p.reset(), { defer: true }));
	return (
		<div style={{ ...t("flex items-start gap-2 rounded-md border p-2"), backgroundColor: tok("warning") }}>
			<Icon name="triangle-alert" size={14} color={tok("warning-foreground")} style={{ marginTop: 1 }} />
			<text style={{ ...tx("text-xs"), color: tok("warning-foreground"), flexShrink: 1, minWidth: 0 }}>This plugin view could not be drawn.</text>
		</div>
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
