import { createMemo, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { AlignLeft, BookOpen, Download, Ellipsis, ExternalLink, FileSearch, Quote } from "lucide-solid";
import { toast } from "solid-sonner";
import { store } from "../store";
import { childKind, doiUrl, openUrl, showInPane, webUrl } from "../itemopen";
import { citeApi, copyRich, type CiteMode } from "../cite/client";
import { copyDoi, fail } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { itemTypeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { creatorLast, parseDate, usePane } from "./ctx";
import { Editable, Section } from "./ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_AUTHORS = 6;

/** Quick Copy citation / bibliography for one item (same path as the Ctrl+Shift+A / C shortcuts). */
async function quickCopy(key: string, mode: CiteMode) {
	try {
		const s = (await citeApi.settings()).quickCopy;
		const r = await citeApi.format({ keys: [key], style: s.style, locale: s.locale, mode, format: ["html", "text"] });
		await copyRich(r.html ?? "", r.text ?? "");
		toast.success(`${mode === "citation" ? "Citation" : "Bibliography"} copied (${s.style})`);
	} catch (e) {
		fail(mode === "citation" ? "Could not copy the citation" : "Could not copy the bibliography", e);
	}
}

const secondary =
	"inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-input bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted [&_svg]:size-3.5";

export const Header: Component = () => {
	const { d, save, schema } = usePane();
	const st = () => schema()?.itemTypes.find((t) => t.itemType === d.data.itemType);
	const primary = () => st()?.creatorTypes.find((c) => c.primary)?.creatorType ?? "author";

	/** Full names of the primary creators (else everyone but contributors), "First Last". */
	const authors = createMemo(() => {
		const all = d.data.creators ?? [];
		let pick = all.filter((c) => c.creatorType === primary());
		if (!pick.length) pick = all.filter((c) => c.creatorType !== "contributor");
		if (!pick.length) pick = all;
		return pick.map((c) => (c.name !== undefined ? c.name : [c.firstName, creatorLast(c)].filter(Boolean).join(" "))).filter(Boolean);
	});

	/** "Journal · 11(10) · e1001744 · Oct 2014"; the journal (or equivalent container) in green italics. */
	const str = (k: string) => ((d.data as Record<string, unknown>)[k] as string | undefined) ?? "";
	const container = () => str("publicationTitle") || str("bookTitle") || str("proceedingsTitle") || str("websiteTitle") || str("blogTitle") || str("publisher");
	const rest = () => {
		const vi = [str("volume"), str("issue") ? `(${str("issue")})` : ""].filter(Boolean).join("");
		const date = parseDate(str("date"));
		const when = date?.y ? [date.m ? MONTHS[+date.m - 1] : "", date.y].filter(Boolean).join(" ") : "";
		return [vi, str("pages"), when].filter(Boolean);
	};

	const reader = () => {
		const kids = d.children.filter((c) => childKind(c) === "reader");
		const rank = (c: (typeof kids)[number]) => (/pdf/i.test(c.contentType ?? "") ? 0 : /epub/i.test(c.contentType ?? "") ? 1 : 2);
		return kids.sort((a, b) => rank(a) - rank(b))[0];
	};
	const hasPdf = () => d.children.some((c) => childKind(c) === "reader" && /pdf/i.test(c.contentType ?? ""));
	const readerLabel = () => {
		const r = reader();
		return /pdf/i.test(r?.contentType ?? "") ? "Open PDF" : /epub/i.test(r?.contentType ?? "") ? "Open EPUB" : "Open snapshot";
	};
	const link = () => webUrl(str("url")) ?? doiUrl(str("DOI"));

	return (
		<header class="flex flex-col gap-2.5 border-b border-border-soft bg-header-tint px-5 pt-5 pb-4" data-testid="ip-header">
			<span class="inline-flex items-center gap-1.5 self-start rounded-full bg-primary-tint px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.06em] text-primary-deep uppercase" title={st()?.label ?? d.data.itemType}>
				<Dynamic component={itemTypeIcon(d.data.itemType)} class="size-3.5" />
				{st()?.label ?? d.data.itemType}
			</span>
			<Editable
				ariaLabel="Item title"
				value={d.data.title ?? ""}
				placeholder="Untitled"
				class="font-title text-[21px] leading-[1.3] font-semibold"
				onSave={(v) => save({ title: v })}
			/>
			<Show when={authors().length}>
				<p class="m-0 text-[13px] leading-normal text-secondary-foreground" data-testid="ip-subtitle">
					{authors().slice(0, MAX_AUTHORS).join(", ")}
					<Show when={authors().length > MAX_AUTHORS}>
						{", "}
						<button type="button" class="text-primary hover:text-primary-deep hover:underline" title="Show all creators" onClick={() => showInPane("info")}>
							+{authors().length - MAX_AUTHORS}
						</button>
					</Show>
				</p>
			</Show>
			<Show when={container() || rest().length}>
				<p class="m-0 text-[13px] text-muted-foreground">
					<Show when={container()}><i class="font-semibold text-journal">{container()}</i></Show>
					<For each={rest()}>{(r, i) => <>{i() > 0 || container() ? " · " : ""}{r}</>}</For>
				</p>
			</Show>
			<div class="mt-1 flex flex-wrap gap-2">
				<Show when={reader()}>
					<button
						type="button"
						class="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-primary transition-colors hover:bg-primary/90 [&_svg]:size-3.5"
						onClick={() => store.openAttachment(reader()!.key, d.data.title || reader()!.title)}
					>
						<BookOpen /> {readerLabel()}
					</button>
				</Show>
				<button type="button" class={secondary} onClick={() => void quickCopy(d.data.key, "citation")}>
					<Quote /> Cite
				</button>
				<Show when={!hasPdf()}>
					<button type="button" class={cn(secondary, "border-primary-line bg-primary-soft text-primary-deep hover:bg-primary-tint")}
						title="Find an open-access or institutional PDF and attach it" onClick={() => findFullText([d.data.key])}>
						<Download /> Find full text
					</button>
				</Show>
				<DropdownMenu>
					<DropdownMenuTrigger class={cn(secondary, "w-8 justify-center px-0")} aria-label="More actions">
						<Ellipsis />
					</DropdownMenuTrigger>
					<DropdownMenuContent class="w-56">
						<DropdownMenuItem onSelect={() => void quickCopy(d.data.key, "bibliography")}>Copy bibliography</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void copyDoi(d.data.key)} disabled={!str("DOI")}>Copy DOI</DropdownMenuItem>
						<Show when={link()}>
							<DropdownMenuItem onSelect={() => void openUrl(link()!)}><ExternalLink class="mr-2 size-4" /> Open webpage</DropdownMenuItem>
						</Show>
						<Show when={hasPdf()}>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => findFullText([d.data.key])}><FileSearch class="mr-2 size-4" /> Find full text again</DropdownMenuItem>
						</Show>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
};

export const AbstractSection: Component = () => {
	const { d, save } = usePane();
	return (
		<Section id="abstract" title="Abstract" icon={AlignLeft}>
			<Editable
				ariaLabel="Abstract"
				multiline
				value={d.data.abstractNote ?? ""}
				placeholder="Add abstract"
				class="leading-[19px]"
				onSave={(v) => save({ abstractNote: v })}
			/>
		</Section>
	);
};
