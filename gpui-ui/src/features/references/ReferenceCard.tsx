// Details of one reference (the web UI's hover card, shown inline under the row here): abstract, counts and actions.
import { createSignal, onMount, Show, type JSX } from "solid-js";
import { Button, Select, toast } from "../../ui";
import { Line, Para, t, Txt } from "../kit";
import { findFullText } from "../fulltext/jobs";
import { copyText, openUrl } from "../platform";
import { collectionOptions } from "../shared";
import { errMsg } from "../text";
import { isAlreadyInLibrary, lookupReference, referencesApi, type Reference, type ReferenceDetail } from "./api";
import { citationText, referenceUrl } from "./match";

export interface ReferenceActions {
	/** Select/open a library item (the host of the panel implements this). */
	onOpenItem?: (key: string) => void;
	/** Called after a reference was added to the library (or found to be there already). */
	onAdded?: (index: number, key: string) => void;
}

async function copyWithToast(text: string, label: string) {
	try {
		await copyText(text);
		toast(`${label} copied`, { kind: "success" });
	} catch (e) {
		toast(`Could not copy ${label.toLowerCase()}`, { kind: "error", description: errMsg(e) });
	}
}
export function openLink(url: string) {
	openUrl(url).catch((e) => toast(`Could not open link: ${errMsg(e)}`, { kind: "error" }));
}

export function ReferenceCard(props: { reference: Reference } & ReferenceActions): JSX.Element {
	const r = () => props.reference;
	const [detail, setDetail] = createSignal<ReferenceDetail | undefined>();
	const [loading, setLoading] = createSignal(false);
	const [detailError, setDetailError] = createSignal("");
	const [collectionKey, setCollectionKey] = createSignal("");
	const [adding, setAdding] = createSignal<false | "add" | "fulltext">(false);

	onMount(() => {
		if (!r().doi && !r().title) return;
		setLoading(true);
		lookupReference(r())
			.then(setDetail, (e) => setDetailError(errMsg(e)))
			.finally(() => setLoading(false));
	});

	// prefer the freshly looked-up data, falling back to what the list already knows
	const d = (): ReferenceDetail => ({ ...r(), ...(detail() ?? {}), inLibraryKey: r().inLibraryKey ?? detail()?.inLibraryKey });
	const url = () => referenceUrl(d());

	/** Add to the library; withFullText then runs Find Full Text on it (the progress panel shows it). */
	async function add(withFullText: boolean) {
		setAdding(withFullText ? "fulltext" : "add");
		try {
			const item = await referencesApi.add({ doi: d().doi, reference: r(), collectionKey: collectionKey() || undefined });
			props.onAdded?.(r().index, item.data.key);
			if (withFullText) findFullText([item.data.key]);
			toast(withFullText ? "Added — finding full text" : "Added to library", {
				kind: "success",
				description: d().title ?? r().raw?.slice(0, 80),
				action: props.onOpenItem ? { label: "Open", run: () => props.onOpenItem!(item.data.key) } : undefined,
			});
		} catch (e) {
			if (isAlreadyInLibrary(e)) {
				const key = (await lookupReference(r()).catch(() => undefined))?.inLibraryKey;
				if (key) {
					props.onAdded?.(r().index, key);
					if (withFullText) findFullText([key]);
				}
				toast("Already in your library", { kind: "info" });
			} else toast(`Could not add: ${errMsg(e)}`, { kind: "error" });
		} finally {
			setAdding(false);
		}
	}

	const meta = () => [d().authors?.join(", "), d().year, d().venue].filter(Boolean).join(" · ");
	const collections = () => [
		{ value: "", label: "Library (no collection)" },
		...collectionOptions().map((c) => ({ value: c.key, label: c.label })),
	];

	return (
		<div style={{ ...t("flex flex-col gap-2 px-3 pb-3 pt-1 bg-muted/40 border-b"), flexShrink: 0 }}>
			<Show when={meta()}>
				<Para class="text-xs text-muted-foreground">{meta()}</Para>
			</Show>
			<Show
				when={d().abstract}
				fallback={
					<Txt class="text-xs text-muted-foreground">
						{loading()
							? "Loading details…"
							: detailError()
								? `Details unavailable (${detailError()}).`
								: "No abstract available."}
					</Txt>
				}
			>
				<Para class="text-xs text-foreground">{d().abstract}</Para>
			</Show>
			<Show when={d().citedByCount != null || d().referenceCount != null || d().type}>
				<Line class="text-xs text-muted-foreground">
					{[
						d().citedByCount != null ? `Cited by ${d().citedByCount}` : "",
						d().referenceCount != null ? `${d().referenceCount} references` : "",
						d().type ?? "",
					]
						.filter(Boolean)
						.join(" · ")}
				</Line>
			</Show>
			<div style={t("flex flex-row flex-wrap gap-1.5")}>
				<Show when={d().inLibraryKey}>
					<Button variant="primary" size="sm" icon="library" onClick={() => props.onOpenItem?.(d().inLibraryKey!)}>
						Open
					</Button>
					<Button size="sm" variant="outline" icon="file-search" onClick={() => findFullText([d().inLibraryKey!])}>
						Find Full Text
					</Button>
				</Show>
				<Button size="sm" variant="outline" icon="external-link" disabled={!url()} onClick={() => url() && openLink(url()!)}>
					Open in browser
				</Button>
				<Show when={d().openAccessUrl}>
					<Button size="sm" variant="outline" icon="book-open" onClick={() => openLink(d().openAccessUrl!)}>
						PDF
					</Button>
				</Show>
				<Button size="sm" variant="outline" icon="quote" onClick={() => void copyWithToast(citationText(d()), "Citation")}>
					Copy citation
				</Button>
				<Show when={d().doi}>
					<Button size="sm" variant="outline" icon="hash" onClick={() => void copyWithToast(d().doi!, "DOI")}>
						Copy DOI
					</Button>
				</Show>
			</div>
			<Show when={!d().inLibraryKey}>
				<div style={t("flex flex-col gap-1.5 rounded-md border bg-background p-2")}>
					<Select value={collectionKey()} onChange={setCollectionKey} options={collections()} />
					<div style={t("flex flex-row gap-1.5")}>
						<Button variant="primary" size="sm" icon="plus" disabled={!!adding()} onClick={() => void add(false)}>
							{adding() === "add" ? "Adding…" : "Add to library"}
						</Button>
						<Button size="sm" variant="outline" icon="file-search" disabled={!!adding()} onClick={() => void add(true)}>
							{adding() === "fulltext" ? "Adding…" : "Add + Find Full Text"}
						</Button>
					</div>
				</div>
			</Show>
		</div>
	);
}
