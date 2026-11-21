// Typings for what the local GPUIX fork (~/src/gpuix, branch zn-cache) adds to the npm @gpuix 0.11 packages. The JS layer
// forwards these props unchanged (custom props are generic), so only the types are missing until the fork's js/host.ts and index.d.ts are published.
import "@gpuix/native/host";
import type { EventPayload } from "@gpuix/native";
import type { HostProps } from "@gpuix/native/host";
import type { SolidHostProps } from "@gpuix/solid/jsx-runtime";

declare module "@gpuix/native/host" {
	interface InputProps {
		/** base text direction; the fork defaults to "auto" (first strong character) */
		dir?: "ltr" | "rtl" | "auto";
	}
	interface GpuixTheme {
		/** <markdown> link text and underline colour (unset: links keep the text colour) */
		link?: string;
	}
	interface MarkdownProps {
		/** links under the pointer fire onMouseEnter / onMouseLeave with value = URL and x/y/width/height = the link's line box */
		linkHover?: boolean;
		/** highlights / underlines over [start, end) UTF-16 ranges of `source` */
		marks?: { start: number; end: number; color?: string; kind?: "highlight" | "underline" }[];
	}
}

// <richtext>: the native WYSIWYG note editor (the fork's custom element; see the gpuix repo's plans/richtext-editor.md section 2).
// `doc` is a ProseMirror JSON document (Zotero's note schema) as a string, semi-controlled like <input value>.
declare module "@gpuix/native/host" {
	interface RichTextTheme {
		text?: string;
		muted?: string;
		accent?: string;
		selection?: string;
		codeBg?: string;
		link?: string;
	}
	/** Runs once per new `seq`. `args` per command: setTextColor / setBgColor {color|null}, setLink {href|null}, setBlock {type},
	 *  insertTable {rows, cols}, insertMath {display}. */
	interface RichTextCommand {
		seq: number;
		name: string;
		args?: Record<string, unknown>;
	}
	interface RichTextProps extends HostProps {
		doc?: string;
		readOnly?: boolean;
		placeholder?: string;
		theme?: RichTextTheme;
		command?: RichTextCommand;
		/** `event.value`: the ProseMirror JSON document string, after every edit */
		onChange?: (event: EventPayload) => void;
		/** `event.value`: the JSON SelectionState (see notes/native/Toolbar.tsx) */
		onSelectionChange?: (event: EventPayload) => void;
		/** `event.value`: the href (ctrl/cmd-click, or any click when readOnly) */
		onLinkClick?: (event: EventPayload) => void;
		/** `event.value`: the citation node's attrs as JSON */
		onCitationClick?: (event: EventPayload) => void;
	}
}

declare module "@gpuix/solid/jsx-runtime" {
	import type { RichTextProps } from "@gpuix/native/host";
	namespace JSX {
		interface IntrinsicElements {
			richtext: SolidHostProps<RichTextProps>;
		}
	}
}
