// Small dialogs the sidebar opens through the shared openDialog(): a one-line text prompt (ui/src/maintenance/dialogs.tsx promptText).
import { createSignal, type JSX } from "solid-js";
import { Button, openDialog, TextInput } from "../ui";
import { t, tx } from "./parts";

function Prompt(p: { description?: string; initial: string; confirmLabel: string; close: (v?: string) => void }): JSX.Element {
	const [v, setV] = createSignal(p.initial);
	const ok = () => {
		const s = v().trim();
		if (s) p.close(s);
	};
	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			{p.description ? <text style={tx("text-[13px] text-muted-foreground")}>{p.description}</text> : <div />}
			<TextInput value={v()} autofocus onInput={setV} onEnter={ok} />
			<div style={t("flex justify-end gap-2")}>
				<Button variant="outline" size="sm" onClick={() => p.close()}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={!v().trim()} onClick={ok}>{p.confirmLabel}</Button>
			</div>
		</div>
	);
}

/** Ask for one line of text; resolves with the trimmed text, or undefined when cancelled. */
export function promptText(o: { title: string; description?: string; initial?: string; confirmLabel?: string }): Promise<string | undefined> {
	return openDialog<string>(
		(close) => <Prompt description={o.description} initial={o.initial ?? ""} confirmLabel={o.confirmLabel ?? "OK"} close={close} />,
		{ title: o.title, width: 400 },
	);
}
