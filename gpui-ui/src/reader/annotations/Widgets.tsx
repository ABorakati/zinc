// Small shared pieces of the annotation UI: the comment box and the tag editor (both write straight to the store).
import { createSignal, For, type JSX } from "solid-js";
import type { Style } from "../../contracts";
import { Icon } from "../../icons";
import { inputTheme, type Kit } from "../structure/kit";
import type { Session } from "./session";

/** Multi-line comment field bound to an annotation's comment. */
export function CommentBox(p: { k: Kit; s: Session; id: string; rows?: number; placeholder?: string; fontSize?: number }): JSX.Element {
	const { store, ui } = p.s;
	return (
		<div
			style={{ ...p.k.t("flex w-full min-w-0 flex-row rounded-md border bg-background px-1.5 py-1"), borderColor: p.k.tok("input") }}
		>
			<textarea
				value={store.get(p.id)?.comment ?? ""}
				placeholder={p.placeholder ?? "Add comment..."}
				minRows={p.rows ?? 1}
				maxRows={8}
				autoFocus={ui.focusComment() === p.id}
				onChange={(e) => store.update(p.id, { comment: (e as { value?: string }).value ?? "" })}
				onFocus={() => {
					if (ui.focusComment() === p.id) ui.setFocusComment(null);
				}}
				style={{
					flexGrow: 1,
					minWidth: 0,
					fontSize: p.fontSize ?? 12,
					lineHeight: (p.fontSize ?? 12) * 1.4,
					fontFamily: "Inter",
					color: p.k.tok("foreground"),
				}}
				theme={inputTheme(p.k)}
			/>
		</div>
	);
}

/** Tag chips with an "add tags" field (Enter or a comma adds). */
export function TagEditor(p: { k: Kit; s: Session; id: string }): JSX.Element {
	const { store } = p.s;
	const [draft, setDraft] = createSignal("");
	const tags = () => store.get(p.id)?.tags ?? [];
	const add = (raw: string) => {
		const names = raw
			.split(/[,;]/)
			.map((x) => x.trim())
			.filter(Boolean);
		setDraft("");
		if (!names.length) return;
		const have = new Set(tags().map((t) => t.name));
		const next = [...tags(), ...names.filter((n, i) => !have.has(n) && names.indexOf(n) === i).map((name) => ({ name }))];
		store.update(p.id, { tags: next });
	};
	const chip: Style = { ...p.k.t("flex flex-row items-center rounded px-1.5 bg-accent"), height: 20, gap: 4 };
	return (
		<div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
			<For each={tags()}>
				{(t) => (
					<div style={chip}>
						<text style={{ ...p.k.tx("text-[11px] text-foreground"), whiteSpace: "nowrap" }}>{t.name}</text>
						<div
							onClick={() => store.update(p.id, { tags: tags().filter((x) => x.name !== t.name) })}
							style={{ cursor: "pointer", display: "flex" }}
						>
							<Icon name="x" size={11} color={p.k.tok("muted-foreground")} />
						</div>
					</div>
				)}
			</For>
			<input
				value={draft()}
				placeholder={tags().length ? "" : "Add tags..."}
				onChange={(e) => {
					const v = (e as { value?: string }).value ?? "";
					if (/[,;]$/.test(v)) add(v);
					else setDraft(v);
				}}
				onSubmit={(e) => add((e as { value?: string }).value ?? draft())}
				onBlur={() => add(draft())}
				style={{ flexGrow: 1, minWidth: 60, height: 20, fontSize: 11, fontFamily: "Inter", color: p.k.tok("foreground") }}
				theme={inputTheme(p.k)}
			/>
		</div>
	);
}

export const TYPE_ICON: Record<string, string> = {
	highlight: "highlighter",
	underline: "underline",
	note: "sticky-note",
	image: "square-dashed",
	ink: "pen-line",
	text: "type",
};
