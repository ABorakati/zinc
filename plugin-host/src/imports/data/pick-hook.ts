// The file dialogs of `fs.pick-open`, `pick-save` and `pick-directory` run in the Zinc process, where the windows are. The ui agent
// (or the app wiring) calls `setFilePicker` with the real dialog. Until then every pick is refused (default deny).
export interface PickOptions {
	title?: string;
	filters: { label: string; extensions: string[] }[];
	persistent: boolean;
}

export type PickKind = "open" | "open-multiple" | "save" | "directory";

export interface PickRequest {
	pluginId: string;
	kind: PickKind;
	options: PickOptions;
	suggestedName?: string;
}

/**
 * Show the dialog and return the chosen absolute paths ([] or undefined when the user cancels). Must refuse (throw, or return
 * undefined) when no Zinc window is focused, as the WIT says. Return isDirectory per path for `directory` picks.
 */
export type FilePicker = (req: PickRequest) => Promise<{ path: string; isDirectory: boolean }[] | undefined>;

let picker: FilePicker | undefined;
export const setFilePicker = (p: FilePicker | undefined): void => {
	picker = p;
};
export const getFilePicker = (): FilePicker | undefined => picker;
