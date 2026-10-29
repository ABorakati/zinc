import { ExternalLink, Library, Hash, Plus, LoaderCircle, BookOpen, Quote, FileSearch } from "lucide-solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Button } from "~/components/ui/button";
import { findFullText } from "~/lib/fulltext";
import { ApiError, lookupReference, referencesApi, type Reference } from "./api";
import { citationText, referenceUrl } from "./match";

export interface ReferenceActions {
	/** Select/open a library item (the reader tab's shell implements this). */
	onOpenItem?: (key: string) => void;
	/** Called after a reference was added to the library (or found to be there already). */
	onAdded?: (index: number, key: string) => void;
}

export async function copyText(text: string, label: string) {
	try {
		await navigator.clipboard.writeText(text);
	}
	catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
	toast.success(`${label} copied`);
}

export function openUrl(url: string) {
	referencesApi.openUrl(url).catch((e) => toast.error(`Could not open link: ${e.message}`));
}

let collectionsPromise: ReturnType<typeof referencesApi.collections> | null = null;
function loadCollections() {
	collectionsPromise ??= referencesApi.collections().catch((e) => { collectionsPromise = null; throw e; });
	return collectionsPromise;
}

/** "Parent / Child" labels in tree order. */
function collectionOptions(all: { key: string; name: string; parentKey: string | null }[]) {
	const byParent = new Map<string | null, typeof all>();
	for (const c of all) byParent.set(c.parentKey, [...(byParent.get(c.parentKey) ?? []), c]);
	const out: { key: string; label: string }[] = [];
	const walk = (parent: string | null, prefix: string) => {
		for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
			out.push({ key: c.key, label: prefix + c.name });
			walk(c.key, prefix + c.name + " / ");
		}
	};
	walk(null, "");
	return out;
}

const smallBtn = "h-7 gap-1.5 px-2 text-xs [&_svg]:size-3.5";

/** Content of the hover card: abstract, counts and actions for one reference. */
export function ReferenceCard(props: { reference: Reference } & ReferenceActions) {
	const r = () => props.reference;
	const [detail] = createResource(() => (r().doi || r().title ? r() : false), (ref) => lookupReference(ref));
	const [collections] = createResource(() => loadCollections().then(collectionOptions));
	const [collectionKey, setCollectionKey] = createSignal("");
	const [adding, setAdding] = createSignal<false | "add" | "fulltext">(false);

	// Prefer the freshly looked-up data, falling back to what the list already knows.
	// (reading a failed resource throws, hence the guards)
	const fetched = () => (detail.error ? undefined : detail());
	const d = () => ({ ...r(), ...(fetched() ?? {}), inLibraryKey: r().inLibraryKey ?? fetched()?.inLibraryKey });
	const url = () => referenceUrl(d());

	/** Add to the library; withFullText then runs Find Full Text on it (started here so the progress panel shows it). */
	async function add(withFullText: boolean) {
		setAdding(withFullText ? "fulltext" : "add");
		try {
			const item = await referencesApi.add({
				doi: d().doi,
				reference: r(),
				collectionKey: collectionKey() || undefined,
			});
			props.onAdded?.(r().index, item.data.key);
			if (withFullText) findFullText([item.data.key]);
			toast.success(withFullText ? "Added — finding full text" : "Added to library", {
				description: d().title ?? r().raw?.slice(0, 80),
				action: props.onOpenItem ? { label: "Open", onClick: () => props.onOpenItem!(item.data.key) } : undefined,
			});
		}
		catch (e) {
			if (e instanceof ApiError && e.status === 409 && typeof e.body.key === "string") {
				props.onAdded?.(r().index, e.body.key);
				toast("Already in your library");
				if (withFullText) findFullText([e.body.key]);
			}
			else toast.error(`Could not add: ${(e as Error).message}`);
		}
		finally {
			setAdding(false);
		}
	}

	return (
		<div class="flex flex-col gap-2 text-xs" data-testid="reference-card">
			<div class="text-[13px] leading-snug font-medium">{d().title ?? d().raw}</div>
			<Show when={d().authors?.length || d().year || d().venue}>
				<div class="text-muted-foreground">
					{[d().authors?.join(", "), d().year, d().venue].filter(Boolean).join(" · ")}
				</div>
			</Show>

			<Show when={detail.loading}>
				<div class="space-y-1.5" aria-label="Loading details">
					<div class="h-3 w-full animate-pulse rounded bg-muted" />
					<div class="h-3 w-11/12 animate-pulse rounded bg-muted" />
					<div class="h-3 w-4/6 animate-pulse rounded bg-muted" />
				</div>
			</Show>
			<Show when={d().abstract}>
				<p class="max-h-32 overflow-y-auto leading-relaxed text-foreground/85" data-testid="reference-abstract">{d().abstract}</p>
			</Show>
			<Show when={!detail.loading && !d().abstract && !detail.error}>
				<p class="text-muted-foreground italic">No abstract available.</p>
			</Show>
			<Show when={detail.error}>
				<p class="text-muted-foreground italic">Details unavailable ({(detail.error as Error).message}).</p>
			</Show>

			<Show when={d().citedByCount != null || d().referenceCount != null || d().type}>
				<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
					<Show when={d().citedByCount != null}><span>Cited by <b class="text-foreground">{d().citedByCount}</b></span></Show>
					<Show when={d().referenceCount != null}><span><b class="text-foreground">{d().referenceCount}</b> references</span></Show>
					<Show when={d().type}><span>{d().type}</span></Show>
				</div>
			</Show>

			<div class="flex flex-wrap gap-1.5">
				<Show when={d().inLibraryKey}>
					<Button size="sm" class={smallBtn} onClick={() => props.onOpenItem?.(d().inLibraryKey!)}>
						<Library /> Open
					</Button>
					<Button size="sm" variant="outline" class={smallBtn} onClick={() => findFullText([d().inLibraryKey!])}>
						<FileSearch /> Find Full Text
					</Button>
				</Show>
				<Button size="sm" variant="outline" class={smallBtn} disabled={!url()} onClick={() => url() && openUrl(url()!)}>
					<ExternalLink /> Open in browser
				</Button>
				<Show when={d().openAccessUrl}>
					<Button size="sm" variant="outline" class={smallBtn} onClick={() => openUrl(d().openAccessUrl!)}>
						<BookOpen /> PDF
					</Button>
				</Show>
				<Button size="sm" variant="outline" class={smallBtn} onClick={() => copyText(citationText(d()), "Citation")}>
					<Quote /> Copy citation
				</Button>
				<Show when={d().doi}>
					<Button size="sm" variant="outline" class={smallBtn} onClick={() => copyText(d().doi!, "DOI")}>
						<Hash /> Copy DOI
					</Button>
				</Show>
			</div>

			<Show when={!d().inLibraryKey}>
				<div class="flex flex-col gap-1.5 rounded-md border bg-muted/40 p-2" data-testid="add-section">
					<div class="flex items-center gap-1.5">
						<select
							class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
							aria-label="Collection"
							value={collectionKey()}
							onChange={(e) => setCollectionKey(e.currentTarget.value)}
						>
							<option value="">Library (no collection)</option>
							<For each={collections.error ? [] : (collections() ?? [])}>{(c) => <option value={c.key}>{c.label}</option>}</For>
						</select>
					</div>
					<div class="flex gap-1.5">
						<Button size="sm" class={smallBtn} disabled={!!adding()} onClick={() => add(false)}>
							{adding() === "add" ? <LoaderCircle class="animate-spin" /> : <Plus />} Add to library
						</Button>
						<Button size="sm" variant="outline" class={smallBtn} disabled={!!adding()} onClick={() => add(true)}>
							{adding() === "fulltext" ? <LoaderCircle class="animate-spin" /> : <FileSearch />} Add + Find Full Text
						</Button>
					</div>
				</div>
			</Show>
		</div>
	);
}
