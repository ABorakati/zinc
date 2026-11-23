// Inline text field for renaming / naming a new collection or search (ui/src/Collections.tsx NameInput):
// Enter or blur commits, Escape cancels. Wraps GPUIX's native <input>; the field takes keyboard focus on mount.
import type { JSX } from "solid-js";
import { claimFocus } from "../ui/core";
import { t, tok, mode } from "./parts";

export function NameInput(p: { value: string; placeholder?: string; onDone: (v: string) => void; onCancel: () => void }): JSX.Element {
	let cur = p.value;
	let finished = false;
	claimFocus(); // it takes the keys on mount: a menu that opened it must not give them back to the row (ui/core.ts)
	const done = (commit: boolean) => {
		if (finished) return;
		finished = true;
		if (commit) p.onDone(cur);
		else p.onCancel();
	};
	return (
		<div style={{ ...t("flex h-5 min-w-0 items-center rounded-md border border-input bg-background px-1"), flexGrow: 1, flexBasis: 0 }}>
			<input
				value={p.value}
				placeholder={p.placeholder}
				autoFocus
				onChange={(e) => {
					cur = (e as { value?: string }).value ?? "";
				}}
				onSubmit={(e) => {
					cur = (e as { value?: string }).value ?? cur;
					done(true);
				}}
				onKeyDown={(e) => {
					if (e.key === "escape") done(false);
				}}
				onBlur={() => done(true)}
				style={{ flexGrow: 1, minWidth: 0, height: 18, fontSize: 13, fontFamily: "Inter", color: tok("foreground") }}
				theme={{
					appearance: mode(),
					bg: tok("background"),
					text: tok("foreground"),
					textMuted: tok("muted-foreground"),
					textFaint: tok("muted-foreground"),
					textDim: tok("muted-foreground"),
					accent: tok("primary"),
					caret: tok("primary"),
					fontSans: "Inter",
				}}
			/>
		</div>
	);
}
