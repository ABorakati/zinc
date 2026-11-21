// Experimental: features that work but are not finished. Each has its own switch here, off by default, so they never change
// anything until someone turns them on. When a feature graduates, its row moves to the section it belongs in.
import { nativeNotes, richTextEditor, setNativeNotes, setRichTextEditor } from "../../notes/native/prefs";
import { setWasmPluginsEnabled, wasmPluginsEnabled } from "../../wasmplugins/flag";
import { Toggle } from "../controls";
import { registerSection, registerSettings } from "../registry";

registerSection({
	id: "experimental",
	label: "Experimental",
	icon: "flask-conical",
	order: 89,
	description: "Features still in progress. They are off until you turn them on, and may change or go away.",
	keywords: ["experimental", "preview", "beta", "labs", "unfinished"],
});

registerSettings([
	{
		id: "experimental.nativeNotes",
		section: "experimental",
		group: "Notes",
		label: "Show notes natively",
		description: "A note opens at once in a native, read-only view. Edit opens it in the usual editor. Text colour is not shown yet.",
		keywords: ["notes", "editor", "native", "fast", "view"],
		control: () => <Toggle checked={nativeNotes()} onChange={setNativeNotes} />,
	},
	{
		id: "experimental.richTextEditor",
		section: "experimental",
		group: "Notes",
		label: "Edit notes natively",
		description:
			"With Show notes natively on, Edit opens a native editor with a formatting toolbar instead of the usual one. Needs a Zinc build whose GPUI toolkit has the native editor.",
		keywords: ["notes", "editor", "native", "wysiwyg", "rich text", "formatting", "toolbar"],
		control: () => <Toggle checked={richTextEditor()} onChange={setRichTextEditor} />,
	},
	{
		id: "experimental.plugins",
		section: "experimental",
		group: "Plugins",
		label: "Enable plugins",
		description:
			"Runs installed plugins in a separate process. Install and manage them under Settings > Plugins. Takes effect the next time Zinc starts.",
		keywords: ["plugins", "extensions", "add-ons", "wasm", "zplugin"],
		control: () => <Toggle checked={wasmPluginsEnabled()} onChange={setWasmPluginsEnabled} />,
	},
]);
