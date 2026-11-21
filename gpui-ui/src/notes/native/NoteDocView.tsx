// PROTOTYPE: a Zotero note drawn natively, read-only, from its ProseMirror document (parse.ts). Block structure (headings, lists,
// quotes, tables, rules, code, maths, images) is native boxes; the text of each block is one <markdown> element (inline.ts),
// with annotation highlights, underlines and background colours as <markdown marks>. No web view.
import { For, Match, Switch, type JSX } from "solid-js";
import { markdownTheme } from "../../itempane/Notes";
import { openLink } from "../../itempane/actions";
import { t, tok, tx } from "../../itempane/kit";
import { Icon } from "../../icons";
import { inlineMarkdown } from "./inline";
import type { NoteNode } from "./parse";

const BLOCK_GAP = 8;
const INDENT_PX = 24;
const BULLETS = ["•", "◦", "▪"];

/** A citation link was clicked: the citation's data (citationItems with uris / itemData). */
export type OnCitation = (citation: Record<string, unknown>) => void;

export function NoteDocView(p: { doc: NoteNode; onCitation?: OnCitation }): JSX.Element {
	return (
		<div testId="native-note" style={{ ...t("flex flex-col"), width: "100%", gap: BLOCK_GAP, userSelect: "text" }}>
			<Blocks nodes={p.doc.content ?? []} depth={0} onCitation={p.onCitation} />
		</div>
	);
}

function Blocks(p: { nodes: NoteNode[]; depth: number; onCitation?: OnCitation }): JSX.Element {
	return <For each={p.nodes}>{(n) => <Block node={n} depth={p.depth} onCitation={p.onCitation} />}</For>;
}

const indentOf = (n: NoteNode) => (Number(n.attrs?.indent) || 0) * INDENT_PX;

function Text(p: { node: NoteNode; prefix?: string; onCitation?: OnCitation }): JSX.Element {
	const r = inlineMarkdown(p.node.content);
	return (
		<markdown
			source={(p.prefix ?? "") + r.source}
			marks={r.marks.map((m) => ({
				...m,
				color: m.color || tok("foreground"),
				start: m.start + (p.prefix?.length ?? 0),
				end: m.end + (p.prefix?.length ?? 0),
			}))}
			theme={markdownTheme()}
			onLinkClick={(e) => {
				const url = String((e as { value?: string }).value ?? "");
				const cite = /^zn-citation:(\d+)$/.exec(url);
				if (cite) p.onCitation?.(r.citations[Number(cite[1])] ?? {});
				else void openLink(url);
			}}
			style={{ width: "100%", paddingLeft: indentOf(p.node) }}
		/>
	);
}

function Block(p: { node: NoteNode; depth: number; onCitation?: OnCitation }): JSX.Element {
	const n = p.node;
	const textOf = (x: NoteNode): string => x.text ?? (x.content ?? []).map(textOf).join("");
	return (
		<Switch fallback={<Text node={n} onCitation={p.onCitation} />}>
			<Match when={n.type === "paragraph" && !(n.content ?? []).length}>
				<div style={{ height: 6 }} />
			</Match>
			<Match when={n.type === "heading"}>
				<Text node={n} prefix={`${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} `} onCitation={p.onCitation} />
			</Match>
			<Match when={n.type === "bulletList" || n.type === "orderedList"}>
				<div style={{ ...t("flex flex-col"), gap: 2, width: "100%" }}>
					<For each={n.content ?? []}>
						{(item, i) => (
							<div style={{ ...t("flex flex-row"), width: "100%" }}>
								<text
									style={{
										...tx("text-[13px] text-muted-foreground"),
										width: 22,
										flexShrink: 0,
										lineHeight: 19,
										textAlign: "right",
										paddingRight: 6,
									}}
								>
									{n.type === "orderedList"
										? `${(Number(n.attrs?.order) || 1) + i()}.`
										: BULLETS[p.depth % BULLETS.length]!}
								</text>
								<div style={{ ...t("flex flex-col"), flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 }}>
									<Blocks nodes={item.content ?? []} depth={p.depth + 1} onCitation={p.onCitation} />
								</div>
							</div>
						)}
					</For>
				</div>
			</Match>
			<Match when={n.type === "blockquote"}>
				<div
					style={{
						...t("flex flex-col"),
						width: "100%",
						gap: BLOCK_GAP,
						borderLeftWidth: 3,
						borderColor: tok("border"),
						paddingLeft: 10,
					}}
				>
					<Blocks nodes={n.content ?? []} depth={p.depth} onCitation={p.onCitation} />
				</div>
			</Match>
			<Match when={n.type === "codeBlock" || n.type === "math_display"}>
				<markdown
					source={"```\n" + (n.type === "math_display" ? `$$${textOf(n)}$$` : textOf(n)) + "\n```"}
					theme={markdownTheme()}
					style={{ width: "100%" }}
				/>
			</Match>
			<Match when={n.type === "horizontalRule"}>
				<div style={{ height: 1, width: "100%", backgroundColor: tok("border"), marginTop: 4, marginBottom: 4 }} />
			</Match>
			<Match when={n.type === "table"}>
				<div style={{ ...t("flex flex-col"), width: "100%", borderWidth: 1, borderColor: tok("border"), borderRadius: 4 }}>
					<For each={n.content ?? []}>
						{(row, r) => (
							<div style={{ ...t("flex flex-row"), width: "100%", borderTopWidth: r() ? 1 : 0, borderColor: tok("border") }}>
								<For each={row.content ?? []}>
									{(cell, c) => (
										<div
											style={{
												...t("flex flex-col"),
												flexGrow: Number(cell.attrs?.colspan) || 1,
												flexShrink: 1,
												flexBasis: 0,
												minWidth: 0,
												gap: 4,
												padding: 6,
												borderLeftWidth: c() ? 1 : 0,
												borderColor: tok("border"),
												backgroundColor:
													(cell.attrs?.background as string | null) ||
													(cell.type === "table_header" ? tok("muted") : "transparent"),
											}}
										>
											<Blocks nodes={cell.content ?? []} depth={p.depth} onCitation={p.onCitation} />
										</div>
									)}
								</For>
							</div>
						)}
					</For>
				</div>
			</Match>
			<Match when={n.type === "image"}>
				<div
					style={{
						...t("flex flex-row items-center gap-2 rounded-md px-3 py-2"),
						backgroundColor: tok("muted"),
						width: "100%",
					}}
				>
					<Icon name="image" size={14} color={tok("muted-foreground")} />
					<text style={{ ...tx("text-xs text-muted-foreground") }}>
						{String(n.attrs?.alt || (n.attrs?.annotation ? "Image annotation" : "Image"))}
					</text>
				</div>
			</Match>
		</Switch>
	);
}
