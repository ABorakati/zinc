// Hooks the host app (the GPUI window) registers so the BBT endpoints can reach the UI: the current selection,
// the cite-as-you-write picker and the clipboard. Without them the endpoints still work with explicit items.
import type { Pick } from "./cite";

export interface CawyRequest {
	format: string;
	params: Record<string, string>;
}

type Selection = () => string[] | Promise<string[]>;
type Picker = (req: CawyRequest) => Promise<Pick[] | null>;
type Clipboard = (text: string) => void | Promise<void>;

let selection: Selection | null = null;
let picker: Picker | null = null;
let clipboard: Clipboard | null = null;

/** Item keys currently selected in the app's item list. */
export function setSelectionProvider(f: Selection | null): void {
	selection = f;
}
/** Opens a quick-search picker in the app; resolves with the picks, or null when cancelled. */
export function setCawyPicker(f: Picker | null): void {
	picker = f;
}
export function setClipboardWriter(f: Clipboard | null): void {
	clipboard = f;
}

export const hasPicker = () => !!picker;
export async function selectedItemKeys(): Promise<string[]> {
	return selection ? await selection() : [];
}
export async function pickInteractively(req: CawyRequest): Promise<Pick[] | null> {
	if (!picker) throw new Error("no picker is available: pass ?selected=1 or ?items=<citekey,...>");
	return picker(req);
}
export async function copyToClipboard(text: string): Promise<boolean> {
	if (!clipboard) return false;
	await clipboard(text);
	return true;
}
