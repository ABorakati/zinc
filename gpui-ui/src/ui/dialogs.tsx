// Modal dialogs: openDialog() and confirm() plus the DialogLayerView OverlayHost draws.
// Look: ui/src/components/ui/dialog.tsx / alert-dialog.tsx ("grid gap-4 border bg-background p-6 shadow-lg sm:rounded-lg"
// over a "bg-background/80" backdrop, title "text-lg font-semibold", description "text-sm text-muted-foreground").
import type { JSX } from "solid-js";
import type { EventPayload } from "@gpuix/native";
import { Icon } from "../icons";
import { Button } from "./controls";
import { focusedId, newId, pushLayer, removeLayer, restoreFocus, t, tok, tx, windowSize, type DialogLayer } from "./core";

export interface DialogOptions { title?: string; width?: number; dismissable?: boolean }

/** A modal dialog; resolves with the value passed to close() (undefined when dismissed with Escape / the X / the backdrop). */
export function openDialog<T = void>(render: (close: (v?: T) => void) => JSX.Element, opts?: DialogOptions): Promise<T | undefined> {
	return openInternal<T>(render, opts, false);
}

function openInternal<T>(render: (close: (v?: T) => void) => JSX.Element, opts: DialogOptions | undefined, alert: boolean, onKey?: (e: EventPayload, close: (v?: T) => void) => void): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		const id = newId();
		const prevFocus = focusedId();
		let done = false;
		const close = (v?: unknown) => {
			if (done) return;
			done = true;
			removeLayer(id);
			restoreFocus(prevFocus);
			resolve(v as T | undefined);
		};
		const layer: DialogLayer = {
			kind: "dialog", id, render: render as DialogLayer["render"], title: opts?.title, width: opts?.width ?? 512,
			dismissable: opts?.dismissable !== false, alert, close, prevFocus,
			onKey: onKey ? (e) => onKey(e, close as (v?: T) => void) : undefined,
		};
		pushLayer(layer);
	});
}

/** Confirmation dialog (alert-dialog): Enter confirms, Escape cancels, the backdrop does nothing. */
export function confirm(o: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
	return openInternal<boolean>(
		(close) => (
			<div style={{ display: "flex", flexDirection: "column" }}>
				<text style={tx("text-lg font-semibold")}>{o.title}</text>
				{o.body ? <text style={{ ...tx("text-sm text-muted-foreground"), marginTop: 8 }}>{o.body}</text> : undefined}
				<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
					<Button variant="outline" onClick={() => close(false)}>{o.cancelLabel ?? "Cancel"}</Button>
					<Button variant={o.danger ? "destructive" : "primary"} onClick={() => close(true)}>{o.confirmLabel ?? "Confirm"}</Button>
				</div>
			</div>
		),
		{ width: 448 },
		true,
		(e, close) => { if (e.key === "enter") close(true); },
	).then((v) => v === true);
}

/** Backdrop + centred panel for one dialog layer. */
export function DialogLayerView(p: { layer: DialogLayer; priority: number }) {
	const l = p.layer;
	const dismiss = () => { if (l.dismissable) l.close(undefined); };
	// the alert variant is not dismissed by the backdrop, but Escape still cancels it
	const onKeyDown = (e: EventPayload) => {
		if (e.key === "escape") { if (l.dismissable || l.alert) l.close(l.alert ? false : undefined); return; }
		l.onKey?.(e);
	};
	return (
		<anchored
			fill="window"
			priority={p.priority}
			style={{ backgroundColor: t("bg-background/80").backgroundColor as string }}
			onClick={() => { if (!l.alert) dismiss(); }}
		>
			<div tabIndex={0} autoFocus onKeyDown={onKeyDown} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", keyboardFocusDim: false }}>
				<div
					style={{
						...t("relative flex flex-col border bg-background p-6 shadow-lg sm:rounded-lg"),
						width: Math.min(l.width, windowSize().width - 32),
						maxHeight: windowSize().height - 32,
						flexShrink: 1,
					}}
				>
					{l.title !== undefined ? <text style={{ ...tx("text-lg font-semibold"), lineHeight: 18, marginBottom: 16 }}>{l.title}</text> : undefined}
					{l.render(l.close)}
					{l.dismissable && !l.alert ? (
						<div
							onClick={() => l.close(undefined)}
							style={{ position: "absolute", top: 16, right: 16, width: 16, height: 16, borderRadius: 2, cursor: "pointer", opacity: 0.7, hover: { opacity: 1 } }}
						>
							<Icon name="x" size={16} color={tok("foreground")} />
						</div>
					) : undefined}
				</div>
			</div>
		</anchored>
	);
}
