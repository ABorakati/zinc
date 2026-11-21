// PROTOTYPE: the editor of one note block in the native note: a <textarea> holding the block's Markdown (blockmd.ts). It commits on
// blur and on Ctrl/Cmd+Enter, and cancels on Escape. The parent decides what a commit does (replace the block, save the note).
import type { JSX } from "solid-js";
import { inputTheme, t, tok } from "../../itempane/kit";

type KeyEvent = { key?: string; modifiers?: { control?: boolean; ctrl?: boolean; cmd?: boolean; meta?: boolean } };

export function NoteEditView(p: {
	/** the block as Markdown ("" for a new paragraph) */
	initial: string;
	onCommit: (markdown: string) => void;
	onCancel: () => void;
}): JSX.Element {
	let draft = p.initial;
	let done = false;
	const finish = (commit: boolean) => {
		if (done) return;
		done = true;
		if (commit) p.onCommit(draft);
		else p.onCancel();
	};
	return (
		<textarea
			testId="native-block-editor"
			autoFocus
			value={p.initial}
			minRows={1}
			maxRows={60}
			placeholder="Write…  Markdown: # heading, **bold**, *italic*, - list, [text](url)"
			onChange={(e) => {
				draft = (e as { value?: string }).value ?? "";
			}}
			onBlur={() => finish(true)}
			onKeyDown={(e) => {
				const k = e as KeyEvent;
				const key = (k.key ?? "").toLowerCase();
				if (key === "escape") finish(false);
				else if (key === "enter" && (k.modifiers?.control || k.modifiers?.ctrl || k.modifiers?.cmd || k.modifiers?.meta))
					finish(true);
			}}
			style={{
				...t("rounded-md"),
				width: "100%",
				padding: 4,
				fontSize: 13,
				lineHeight: 18,
				color: tok("foreground"),
				backgroundColor: tok("background"),
				borderWidth: 1,
				borderColor: tok("primary"),
			}}
			theme={inputTheme()}
		/>
	);
}
