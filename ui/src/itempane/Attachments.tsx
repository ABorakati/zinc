import { For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { BookOpen, ExternalLink, FileSearch, FileText, FolderOpen, Globe, Link, MessageSquareText, Paperclip, type LucideProps } from "lucide-solid";
import { api, type ChildSummary } from "../api";
import { store } from "../store";
import { fail } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { cn } from "~/lib/utils";
import { ipApi } from "./api";
import { usePane } from "./ctx";
import { IconBtn, Section, TextBtn } from "./ui";

function iconFor(c: ChildSummary): { icon: Component<LucideProps>; color: string } {
	const ct = c.contentType ?? "";
	if (c.linkMode === "linked_url") return { icon: Link, color: "text-sky-500" };
	if (/pdf/i.test(ct)) return { icon: FileText, color: "text-red-500" };
	if (/epub/i.test(ct)) return { icon: BookOpen, color: "text-emerald-500" };
	if (/html/i.test(ct)) return { icon: Globe, color: "text-sky-500" };
	return { icon: Paperclip, color: "text-muted-foreground" };
}

export const AttachmentsSection: Component = () => {
	const { d } = usePane();
	const atts = () => d.children.filter((c) => c.itemType === "attachment");
	const guard = (what: string, fn: () => Promise<unknown>) => async (e?: MouseEvent) => {
		e?.stopPropagation();
		try { await fn(); } catch (err) { fail(what, err); }
	};
	const open = (c: ChildSummary) => {
		if (c.linkMode === "linked_url") {
			return guard("Could not open link", async () => {
				const url = (await api.item(c.key)).data.url;
				if (url) await ipApi.openUrl(url);
			})();
		}
		if (c.hasFile) store.openAttachment(c.key, d.data.title || c.title);
	};

	return (
		<Section
			id="attachments"
			title="Attachments"
			icon={Paperclip}
			count={atts().length}
			actions={
				<TextBtn title="Find an open-access or institutional PDF and attach it" onClick={() => findFullText([d.data.key])}>
					<FileSearch /> Find Full Text
				</TextBtn>
			}
		>
			<Show when={atts().length} fallback={<div class="px-1.5 py-1 text-xs text-muted-foreground">No attachments</div>}>
				<For each={atts()}>
					{(c) => {
						const ic = iconFor(c);
						const missing = () => c.linkMode !== "linked_url" && !c.hasFile;
						return (
							<div
								class="group/att flex items-center gap-1.5 rounded px-1.5 py-[3px] hover:bg-accent/60"
								data-attachment={c.key}
								onDblClick={() => open(c)}
							>
								<Dynamic component={ic.icon} class={cn("size-4 flex-none", ic.color, missing() && "opacity-40")} />
								<span class={cn("min-w-0 flex-1 truncate", missing() && "text-muted-foreground line-through decoration-muted-foreground/50")} title={c.title}>
									{c.title || "Attachment"}
								</span>
								<Show when={missing()}>
									<span class="flex-none rounded bg-warning px-1 text-[11px] text-warning-foreground">File missing</span>
								</Show>
								<Show when={c.annotationCount > 0}>
									<span class="inline-flex flex-none items-center gap-0.5 text-[11px] text-muted-foreground" title={`${c.annotationCount} annotation${c.annotationCount === 1 ? "" : "s"}`}>
										<MessageSquareText class="size-3" />
										{c.annotationCount}
									</span>
								</Show>
								<div class="flex flex-none items-center gap-px opacity-0 transition-opacity group-focus-within/att:opacity-100 group-hover/att:opacity-100">
									<Show when={c.hasFile || c.linkMode === "linked_url"}>
										<IconBtn title={c.linkMode === "linked_url" ? "Open link" : "Open in reader tab"} onClick={() => open(c)}>
											<BookOpen />
										</IconBtn>
									</Show>
									<Show when={c.hasFile}>
										<IconBtn title="Show File" onClick={guard("Could not show file", () => ipApi.reveal(c.key))}><FolderOpen /></IconBtn>
										<IconBtn title="Open in default app" onClick={guard("Could not open file", () => ipApi.openExternal(c.key))}><ExternalLink /></IconBtn>
									</Show>
								</div>
							</div>
						);
					}}
				</For>
			</Show>
		</Section>
	);
};
