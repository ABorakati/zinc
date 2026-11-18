// What WASM plugins registered with `reader.register-*` and `note-editor.register-head`, per plugin, as one reactive revision.
// bridge.tsx turns it into ReaderPlugin objects (src/reader/plugins.ts); nothing here touches the UI.
import { createSignal } from "solid-js";
import type {
	EventKind,
	LinkInterceptorRegistration,
	ListenerRegistration,
	NoteEventKind,
	OverlayRegistration,
	PanelRegistration,
} from "./types";

export interface PluginRegs {
	listeners: Map<string, ListenerRegistration>;
	panels: Map<string, PanelRegistration>;
	overlays: Map<string, OverlayRegistration>;
	interceptors: Map<string, LinkInterceptorRegistration>;
	heads: Set<string>;
	events: Set<EventKind>;
	noteEvents: Set<NoteEventKind>;
}

const regs = new Map<string, PluginRegs>();
const [rev, setRev] = createSignal(0);
/** Reactive: read it to follow every change of every registration. */
export const registrationRev = (): number => rev();
const bump = () => setRev((n) => n + 1);

const make = (): PluginRegs => ({
	listeners: new Map(),
	panels: new Map(),
	overlays: new Map(),
	interceptors: new Map(),
	heads: new Set(),
	events: new Set(),
	noteEvents: new Set(),
});

export function regsOf(plugin: string): PluginRegs | undefined {
	rev();
	return regs.get(plugin);
}
export function regsFor(plugin: string): PluginRegs {
	let r = regs.get(plugin);
	if (!r) regs.set(plugin, (r = make()));
	return r;
}
export const pluginsWithRegs = (): string[] => {
	rev();
	return [...regs.keys()];
};

/** Everything of one id, whatever kind (`reader.unregister`). A missing id is not an error. */
export function unregisterId(plugin: string, id: string): void {
	const r = regs.get(plugin);
	if (!r) return;
	const had = r.listeners.delete(id) || r.panels.delete(id) || r.overlays.delete(id) || r.interceptors.delete(id);
	if (had) bump();
}

export function changed(): void {
	bump();
}

/** Drop one plugin's registrations (every plugin when undefined); returns the plugins that had any. */
export function clearRegistrations(plugin?: string): string[] {
	const gone = plugin === undefined ? [...regs.keys()] : regs.has(plugin) ? [plugin] : [];
	for (const p of gone) regs.delete(p);
	if (gone.length) bump();
	return gone;
}

/** Plugins that asked for this event kind. */
export function subscribers(kind: EventKind): string[] {
	return [...regs].filter(([, r]) => r.events.has(kind)).map(([p]) => p);
}
export function noteSubscribers(kind: NoteEventKind): string[] {
	return [...regs].filter(([, r]) => r.noteEvents.has(kind)).map(([p]) => p);
}

/** Bumped by `invalidate`: slots, panels and overlays of the plugin draw again. Key: plugin + id (+ reader). */
const [inv, setInv] = createSignal<Map<string, number>>(new Map());
const ik = (plugin: string, id: string, reader?: string) => `${plugin}\u0000${id}\u0000${reader ?? ""}`;
export function invalidate(plugin: string, id: string, reader?: string): void {
	const m = new Map(inv());
	for (const k of reader ? [ik(plugin, id, reader)] : [ik(plugin, id), ik(plugin, id, "*")]) m.set(k, (m.get(k) ?? 0) + 1);
	setInv(m);
}
/** Reactive counter for (plugin, id, reader): read it inside the thing that must redraw. */
export const invalidationOf = (plugin: string, id: string, reader: string): number => {
	const m = inv();
	return (m.get(ik(plugin, id, "*")) ?? 0) + (m.get(ik(plugin, id, reader)) ?? 0);
};
