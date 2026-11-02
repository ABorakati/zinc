// Cards shown in the academic popovers and panels: a bibliography reference (abstract, add to library, open), a figure / table
// preview, a supplementary-material match and the list for a citation group like "[3, 5-7]".
import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { Button } from "../../ui";
import { kit, RegionImage, type Kit } from "../structure/kit";
import { renderRegion, type Crop } from "../structure/regions";
import type { PdfRect } from "../structure/types";
import { openAttachmentTab, openInLibrary, openUrl } from "./actions";
import { extractDoi, referenceUrl } from "./match";
import type { FigItem } from "./figures";
import type { SuppMention } from "./mentions";
import { formatSize, matchSupplement, supplementaryItems, type SuppItem } from "./supp";
import type { AcademicSession } from "./session";
import type { Reference, ReferenceDetail } from "./types";

export interface RefCardOpts {
	ref: Reference | null;
	/** text of the bibliography entry as printed in this PDF (shown when there is no API match) */
	rawText?: string;
	onJump?: () => void; // "Jump to reference in this PDF"
	onShowInRefs?: (index: number) => void;
	compact?: boolean; // list rows: no lookup until asked
	onChange?: () => void;
}

export function RefCard(p: { s: AcademicSession; opts: RefCardOpts }): JSX.Element {
	const k = kit(p.s.ctx.mode);
	const o = p.opts;
	const [detail, setDetail] = createSignal<ReferenceDetail | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [failed, setFailed] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal<string | null>(null);
	const [addError, setAddError] = createSignal<string | null>(null);
	const [libKey, setLibKey] = createSignal<string | undefined>(o.ref?.inLibraryKey);

	onMount(() => {
		const r = o.ref;
		if (!r || (!r.doi && !r.title)) return;
		setLoading(true);
		p.s.api.lookup(r).then((d) => setDetail(d), (e) => setFailed((e as Error).message)).finally(() => setLoading(false));
	});
	const d = createMemo(() => ({ index: 0, ...(o.ref ?? {}), ...(detail() ?? {}) }) as Reference & Partial<ReferenceDetail>);
	const inLib = () => libKey() ?? detail()?.inLibraryKey;
	const doi = () => d().doi ?? extractDoi(o.rawText);
	const url = () => (o.ref || doi() ? referenceUrl({ ...d(), doi: doi() }) : undefined);
	const meta = () => {
		const a = d().authors;
		const authors = a?.length ? a.slice(0, 6).join(", ") + (a.length > 6 ? " et al." : "") : "";
		return [authors, d().year, d().venue].filter((x) => x !== undefined && x !== "").join(" · ");
	};
	const stats = () => [d().citedByCount != null ? `Cited by ${d().citedByCount}` : "", d().referenceCount != null ? `${d().referenceCount} references` : "", d().type ?? ""].filter(Boolean).join(" · ");

	async function add() {
		setBusy("add");
		setAddError(null);
		try {
			const key = await p.s.api.add({ doi: doi(), reference: o.ref ?? undefined });
			setLibKey(key);
			if (o.ref) o.ref.inLibraryKey = key;
			o.onChange?.();
		} catch (e) { setAddError(`Could not add: ${(e as Error).message}`); }
		setBusy(null);
	}

	const small = k.tx("text-[11.5px] text-muted-foreground");
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 6, minWidth: 0 }}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
				<div style={{ display: "flex", flexGrow: 1, minWidth: 0 }}>
					<text style={{ ...k.tx("text-[13px] font-medium text-foreground"), lineClamp: o.compact ? 3 : 4 }}>{d().title ?? d().raw ?? o.rawText ?? "Reference"}</text>
				</div>
				<Show when={inLib()}>
					<div style={{ ...k.t("flex flex-none items-center rounded bg-primary/15 px-1.5"), height: 18 }}>
						<text style={{ ...k.tx("text-[10.5px] font-medium text-primary"), whiteSpace: "nowrap" }}>In library</text>
					</div>
				</Show>
			</div>
			<Show when={meta()}><text style={{ ...small, lineClamp: 2 }}>{meta()}</text></Show>
			<Show when={!o.ref && o.rawText}>
				<div style={{ ...k.t("flex rounded-md bg-muted p-2") }}><text style={{ ...k.tx("text-[11.5px] text-foreground") }}>{o.rawText ?? ""}</text></div>
				<text style={small}>No match in the resolved bibliography.</text>
			</Show>
			<Show when={loading()}>
				<div style={{ ...k.t("rounded bg-muted"), height: 10 }} />
				<div style={{ ...k.t("rounded bg-muted"), height: 10, width: "80%" }} />
			</Show>
			<Show when={!loading() && detail()?.abstract}>
				<text style={{ ...k.tx("text-[12px] text-foreground"), lineClamp: o.compact ? 6 : 9 }}>{detail()!.abstract ?? ""}</text>
			</Show>
			<Show when={!loading() && !detail()?.abstract && o.ref && !failed() && !o.compact}><text style={small}>No abstract available.</text></Show>
			<Show when={failed()}><text style={small}>{`Details unavailable (${failed()}).`}</text></Show>
			<Show when={stats()}><text style={small}>{stats()}</text></Show>
			<div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
				<Show
					when={inLib()}
					fallback={
						<Show when={o.ref || doi()}>
							<Button size="sm" variant="primary" disabled={busy() !== null} onClick={() => void add()}>{busy() ? "Adding..." : "Add to library"}</Button>
						</Show>
					}
				>
					<Button size="sm" variant="primary" onClick={() => void openInLibrary(inLib()!)}>Open in library</Button>
				</Show>
				<Show when={url()}><Button size="sm" onClick={() => openUrl(p.s.ctx, p.s.api, url()!)}>Open in browser</Button></Show>
				<Show when={d().openAccessUrl}><Button size="sm" onClick={() => openUrl(p.s.ctx, p.s.api, d().openAccessUrl!)}>Open PDF</Button></Show>
				<Show when={o.ref && o.onShowInRefs}><Button size="sm" onClick={() => o.onShowInRefs!(o.ref!.index)}>Show in References</Button></Show>
				<Show when={o.onJump}><Button size="sm" onClick={() => o.onJump!()}>Jump to reference</Button></Show>
			</div>
			<Show when={addError()}><text style={k.tx("text-[11.5px] text-destructive")}>{addError()!}</text></Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- figures

/** Crop of a figure / table (resolves later; null if it cannot be rendered). */
export function useCrop(s: AcademicSession, it: FigItem, width: number) {
	const [crop, setCrop] = createSignal<Crop | null>(null);
	const area: PdfRect = it.area ?? it.rect;
	void renderRegion(s.ctx, it.page, area, width * 2).then(setCrop);
	return crop;
}

export function FigureCard(p: { s: AcademicSession; item: FigItem }): JSX.Element {
	const k = kit(p.s.ctx.mode);
	const it = p.item;
	const crop = useCrop(p.s, it, 340);
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 6, minWidth: 0 }}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "baseline", gap: 8 }}>
				<text style={{ ...k.tx("text-[13px] font-medium text-foreground"), whiteSpace: "nowrap" }}>{it.label}</text>
				<text style={{ ...k.tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{`page ${it.page + 1}`}</text>
			</div>
			<RegionImage k={k} crop={crop} width={340} maxHeight={260} fallbackHeight={90} />
			<Show when={it.caption} fallback={<text style={k.tx("text-[11.5px] text-muted-foreground")}>No caption found.</text>}>
				<text style={{ ...k.tx("text-[11.5px] text-muted-foreground"), lineClamp: 6 }}>{it.caption ?? ""}</text>
			</Show>
			<div style={{ display: "flex", flexDirection: "row" }}>
				<Button size="sm" variant="primary" onClick={() => p.s.jump(it.page, it.rect)}>{`Go to ${it.kind}`}</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- supplementary

export function SuppCard(p: { s: AcademicSession; mention: SuppMention }): JSX.Element {
	const k = kit(p.s.ctx.mode);
	const [items, setItems] = createSignal<SuppItem[] | null>(null);
	onMount(() => { void p.s.api.children().then((c) => setItems(supplementaryItems(c, p.s.ctx.attachmentKey)), () => setItems([])); });
	const matches = createMemo(() => matchSupplement(p.mention, items() ?? []));
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 6 }}>
			<text style={k.tx("text-[13px] font-medium text-foreground")}>{p.mention.label}</text>
			<Show when={items() !== null} fallback={<text style={k.tx("text-[11.5px] text-muted-foreground")}>Looking for the attachment...</text>}>
				<Show
					when={matches().length > 0}
					fallback={<text style={k.tx("text-[11.5px] text-muted-foreground")}>{(items() ?? []).length ? "No attachment of this item matches." : "This item has no other attachments."}</text>}
				>
					<For each={matches().slice(0, 4)}>{(m) => <SuppRow s={p.s} item={m.item} />}</For>
				</Show>
			</Show>
		</div>
	);
}

export async function openSupplement(s: AcademicSession, item: SuppItem): Promise<void> {
	if (item.kind === "pdf" || item.kind === "epub") await openAttachmentTab(item.key, item.title, s.ctx.itemKey);
	else if (item.kind === "link") {
		const it = await s.api.item(item.key);
		const url = typeof it.data.url === "string" ? it.data.url : undefined;
		if (url) openUrl(s.ctx, s.api, url);
	} else await s.api.openExternal(item.key);
}

export function SuppRow(p: { s: AcademicSession; item: SuppItem }): JSX.Element {
	const k = kit(p.s.ctx.mode);
	const [size, setSize] = createSignal<number | null>(null);
	onMount(() => {
		if (!p.item.hasFile || p.item.kind === "link") return;
		void import("../../api").then(({ BASE_URL }) => fetch(`${BASE_URL}/api/attachments/${encodeURIComponent(p.item.key)}/file`, { method: "HEAD" }))
			.then((r) => { const n = Number(r.headers.get("content-length")); if (r.ok && n > 0) setSize(n); }).catch(() => {});
	});
	return (
		<div
			onClick={() => void openSupplement(p.s, p.item).catch((e) => console.warn("[academic] open failed:", (e as Error).message))}
			style={{ ...k.t("flex flex-row items-center rounded-md border px-2"), height: 36, gap: 8, cursor: "pointer", hover: k.t("bg-accent"), borderColor: k.tok("border") }}
		>
			<div style={{ ...k.t("flex flex-none items-center justify-center rounded bg-muted"), width: 34, height: 18 }}>
				<text style={{ ...k.tx("text-[9.5px] font-medium text-muted-foreground"), whiteSpace: "nowrap" }}>{p.item.kind.toUpperCase()}</text>
			</div>
			<div style={{ display: "flex", flexGrow: 1, minWidth: 0 }}>
				<text style={{ ...k.tx("text-[12px] text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.item.title}</text>
			</div>
			<Show when={size() !== null}><text style={{ ...k.tx("text-[10.5px] text-muted-foreground"), whiteSpace: "nowrap" }}>{formatSize(size()!)}</text></Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- citation group

export function CiteGroup(p: { s: AcademicSession; k: Kit; text: string; entries: { n: number; ref: Reference | null }[]; onShowInRefs?: (i: number) => void }): JSX.Element {
	const [open, setOpen] = createSignal<number | null>(null);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
			<text style={p.k.tx("text-[11.5px] text-muted-foreground")}>{`${p.entries.length} references: ${p.text.trim()}`}</text>
			<For each={p.entries}>
				{(e) => (
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<div
							onClick={() => setOpen(open() === e.n ? null : e.n)}
							style={{ ...p.k.t("flex flex-row items-start rounded-md px-1.5 py-1"), gap: 6, cursor: e.ref ? "pointer" : "default", hover: e.ref ? p.k.t("bg-accent") : {} }}
						>
							<text style={{ ...p.k.tx("text-[11.5px] font-medium text-primary"), whiteSpace: "nowrap" }}>{`[${e.n}]`}</text>
							<text style={{ ...p.k.tx("text-[12px] text-foreground"), lineClamp: 2 }}>{e.ref ? (e.ref.title ?? e.ref.raw ?? "") : "(not found in the resolved bibliography)"}</text>
						</div>
						<Show when={open() === e.n && e.ref}>
							<div style={{ paddingLeft: 24 }}><RefCard s={p.s} opts={{ ref: e.ref, compact: true, onShowInRefs: p.onShowInRefs }} /></div>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}
