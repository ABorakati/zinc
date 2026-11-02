// Citation style picker: search the installed styles and the Zotero Style Repository (~10,000 styles) with format/field filters and
// a live preview of the highlighted style. Used by the Citation Style Settings and Create Bibliography dialogs.
// Not ported from the web picker: arrow-key browsing (no key events on the list yet) and the double-click-to-use shortcut.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Button, Checkbox, Select, TextInput, toast } from "../../ui";
import { Chip, Line, Para, Row, Scroll, t, tok, Txt } from "../kit";
import { errMsg, htmlToText } from "../text";
import { bumpCite, citeApi, type CiteStyleInfo, type CiteStylePreview } from "./client";

const FORMATS: { value: string; label: string }[] = [
	{ value: "", label: "Any format" }, { value: "author-date", label: "Author-date" }, { value: "numeric", label: "Numeric" },
	{ value: "note", label: "Note" }, { value: "label", label: "Label" }, { value: "author", label: "Author" },
];
const FIELDS = [
	"medicine", "biology", "science", "psychology", "social_science", "humanities", "engineering", "physics", "chemistry", "law",
	"history", "philosophy", "political_science", "sociology", "communications", "anthropology", "geography", "linguistics",
	"literature", "theology", "geology", "zoology", "botany", "math", "astronomy", "generic-base",
];
const fieldLabel = (f: string) => (f === "generic-base" ? "Generic" : f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
const formatLabel = (f: string) => FORMATS.find((x) => x.value === f)?.label ?? f;
const PAGE = 100;

type ListRow = { kind: "head"; label: string } | { kind: "style"; s: CiteStyleInfo };

export function StylePicker(props: {
	/** The style currently in use. */
	value: string;
	/** Called with the chosen style (after it was installed if needed). */
	onChange: (id: string, info?: CiteStyleInfo) => void;
	/** Items to preview with (the user's selection); omitted: a few from the library. */
	itemKeys?: string[];
	height?: number;
}): JSX.Element {
	const H = props.height ?? 300;
	const [q, setQ] = createSignal("");
	const [format, setFormat] = createSignal("");
	const [field, setField] = createSignal("");
	const [instOnly, setInstOnly] = createSignal(false);
	const [list, setList] = createSignal<CiteStyleInfo[]>([]);
	const [total, setTotal] = createSignal(0);
	const [index, setIndex] = createSignal("fresh");
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal("");
	const [hi, setHi] = createSignal(""); // highlighted style id (drives the preview)
	const [busy, setBusy] = createSignal<"install" | "use" | "remove" | null>(null);
	const [confirmRemove, setConfirmRemove] = createSignal("");
	const [preview, setPreview] = createSignal<CiteStylePreview | null>(null);
	const [pvLoading, setPvLoading] = createSignal(false);
	const [pvError, setPvError] = createSignal("");
	let searchCtl: AbortController | undefined;
	let pvCtl: AbortController | undefined;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let pvTimer: ReturnType<typeof setTimeout> | undefined;
	const pvCache = new Map<string, CiteStylePreview>();
	onCleanup(() => { searchCtl?.abort(); pvCtl?.abort(); clearTimeout(searchTimer); clearTimeout(pvTimer); });

	const rows = createMemo<ListRow[]>(() => {
		const l = list();
		const inst = l.filter((s) => s.installed), repo = l.filter((s) => !s.installed);
		const out: ListRow[] = [];
		if (inst.length) { out.push({ kind: "head", label: `INSTALLED (${inst.length})` }); for (const s of inst) out.push({ kind: "style", s }); }
		if (repo.length && !instOnly()) {
			out.push({ kind: "head", label: `ZOTERO STYLE REPOSITORY${q() || format() || field() ? ` (${Math.max(total() - inst.length, repo.length)})` : ""}` });
			for (const s of repo) out.push({ kind: "style", s });
		}
		return out;
	});
	const current = createMemo(() => list().find((s) => s.id === hi()));

	// ---- search (debounced, cancels the request it replaces)
	const run = (append: boolean) => {
		searchCtl?.abort();
		const ctl = (searchCtl = new AbortController());
		setLoading(true);
		setError("");
		citeApi
			.searchStyles({ q: q().trim(), format: format(), field: field(), installed: instOnly(), limit: PAGE, offset: append ? list().length : 0 }, ctl.signal)
			.then((r) => {
				if (ctl.signal.aborted) return;
				const merged = append ? [...list(), ...r.styles.filter((s) => !list().some((x) => x.id === s.id))] : r.styles;
				setList(merged);
				setTotal(r.total);
				setIndex(r.index);
				setLoading(false);
				if (!append && !merged.some((s) => s.id === hi())) setHi(merged.find((s) => s.id === props.value)?.id ?? merged[0]?.id ?? "");
			})
			.catch((e) => {
				if (ctl.signal.aborted) return;
				setLoading(false);
				setError(errMsg(e));
			});
	};
	onMount(() => { setHi(props.value); run(false); });
	createEffect(on([q, format, field, instOnly], () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => run(false), 150);
	}, { defer: true }));

	// ---- live preview of the highlighted style (debounced; a newer selection cancels the older request)
	const keysKey = () => (props.itemKeys ?? []).slice(0, 3).join(",");
	createEffect(() => {
		const id = hi();
		const kk = keysKey();
		clearTimeout(pvTimer);
		pvCtl?.abort();
		if (!id) { setPreview(null); setPvLoading(false); return; }
		const hit = pvCache.get(`${id}|${kk}`);
		if (hit) { setPreview(hit); setPvError(""); setPvLoading(false); return; }
		setPvLoading(true);
		pvTimer = setTimeout(() => {
			const ctl = (pvCtl = new AbortController());
			citeApi.preview(id, kk ? kk.split(",") : [], ctl.signal).then(
				(p) => { if (ctl.signal.aborted) return; pvCache.set(`${id}|${kk}`, p); setPreview(p); setPvError(""); setPvLoading(false); },
				(e) => { if (ctl.signal.aborted) return; setPreview(null); setPvError(errMsg(e)); setPvLoading(false); },
			);
		}, 200);
	});

	// ---- actions
	const patch = (id: string, p: Partial<CiteStyleInfo>) => setList((l) => l.map((s) => (s.id === id ? { ...s, ...p } : s)));
	const install = async (s: CiteStyleInfo) => {
		const info = await citeApi.install(s.id);
		patch(s.id, { installed: true, removable: info.removable, title: info.title || s.title });
		if (s.dependent) run(false); // a dependent style brings its parent along
		bumpCite();
		return info;
	};
	const use = async () => {
		const s = current();
		if (!s || busy()) return;
		setBusy("use");
		try {
			const info = s.installed ? s : await install(s);
			props.onChange(s.id, { ...s, ...info, installed: true });
		} catch (e) {
			toast(`Could not use "${s.title}"`, { kind: "error", description: errMsg(e) });
		} finally {
			setBusy(null);
		}
	};
	const doInstall = async () => {
		const s = current();
		if (!s || busy()) return;
		setBusy("install");
		try { await install(s); toast(`Installed "${s.title}"`, { kind: "success" }); }
		catch (e) { toast(`Could not install "${s.title}"`, { kind: "error", description: errMsg(e) }); }
		finally { setBusy(null); }
	};
	const doRemove = async () => {
		const s = current();
		if (!s || busy()) return;
		if (confirmRemove() !== s.id) { setConfirmRemove(s.id); return; }
		setConfirmRemove("");
		setBusy("remove");
		try { await citeApi.remove(s.id); toast(`Removed "${s.title}"`, { kind: "success" }); bumpCite(); run(false); }
		catch (e) { toast(`Could not remove "${s.title}"`, { kind: "error", description: errMsg(e) }); }
		finally { setBusy(null); }
	};

	const chips = (s: CiteStyleInfo) => {
		const out: string[] = [];
		if (s.format) out.push(formatLabel(s.format));
		for (const f of (s.fields ?? []).filter((x) => x !== "generic-base").slice(0, 2)) out.push(fieldLabel(f));
		if (s.dependent) out.push("journal");
		return out;
	};

	return (
		<div style={{ ...t("flex flex-col gap-2"), width: "100%" }}>
			<TextInput value={q()} onInput={setQ} autofocus placeholder="Search installed styles and the Zotero Style Repository (e.g. lancet, harvard, nature)" />
			<div style={t("flex flex-row items-center gap-2")}>
				<Select value={format()} onChange={setFormat} width={140} options={FORMATS} />
				<Select value={field()} onChange={setField} width={160} options={[{ value: "", label: "Any field" }, ...FIELDS.map((f) => ({ value: f, label: fieldLabel(f) }))]} />
				<Checkbox checked={instOnly()} onChange={setInstOnly} label="Installed only" />
			</div>
			<Show when={index() === "none" && !instOnly()}>
				<div style={t("flex flex-row items-center gap-1.5 rounded-md border bg-warning px-2 py-1")}>
					<Icon name="wifi-off" size={14} color={tok("warning-foreground")} />
					<Txt class="text-xs text-warning-foreground">The Zotero Style Repository could not be reached; only installed and default styles are listed.</Txt>
				</div>
			</Show>
			<div style={{ ...t("flex flex-row gap-2"), width: "100%", height: H }}>
				{/* ---- list */}
				<Scroll border style={{ width: "42%", height: H, flexShrink: 0 }}>
					<Show when={!error()} fallback={<div style={t("p-3")}><Para class="text-[13px] text-destructive">{error()}</Para></div>}>
						<For each={rows()} fallback={<div style={t("p-3")}><Txt class="text-[13px] text-muted-foreground">{loading() ? "Searching…" : "No styles match."}</Txt></div>}>
							{(r) =>
								r.kind === "head" ? (
									<div style={{ ...t("border-b bg-muted px-2 py-0.5"), flexShrink: 0 }}><Txt class="text-[11px] font-semibold text-muted-foreground">{r.label}</Txt></div>
								) : (
									<Row selected={hi() === r.s.id} onClick={() => { setHi(r.s.id); setConfirmRemove(""); }} style={{ flexShrink: 0, flexDirection: "column", alignItems: "stretch", gap: 2, paddingTop: 4, paddingBottom: 4 }}>
										<div style={t("flex flex-row items-center gap-1.5")}>
											<div style={{ width: 16, flexShrink: 0 }}>{props.value === r.s.id ? <Icon name="check" size={14} color={tok("foreground")} /> : null}</div>
											<Line class="text-[13px] text-foreground" style={{ flexGrow: 1 }}>{r.s.title}</Line>
										</div>
										<div style={{ ...t("flex flex-row items-center gap-1"), paddingLeft: 22 }}>
											<For each={chips(r.s)}>{(c) => <Chip>{c}</Chip>}</For>
										</div>
									</Row>
								)
							}
						</For>
						<Show when={list().length < total()}>
							<Row onClick={() => !loading() && run(true)} style={{ flexShrink: 0, justifyContent: "center" }}>
								<Txt class="text-xs text-muted-foreground">{loading() ? "Loading…" : `Show more (${list().length} of ${total()})`}</Txt>
							</Row>
						</Show>
					</Show>
				</Scroll>
				{/* ---- preview */}
				<div style={{ ...t("flex flex-col rounded-md border"), flexGrow: 1, flexShrink: 1, minWidth: 0, height: H }}>
					<Show when={current()} fallback={<div style={t("p-3")}><Txt class="text-[13px] text-muted-foreground">Select a style to preview it.</Txt></div>}>
						{(s) => (
							<>
								<div style={t("flex flex-col gap-1 border-b px-3 py-2")}>
									<Line class="text-[13px] font-medium text-foreground">{s().title}</Line>
									<div style={t("flex flex-row flex-wrap items-center gap-1")}>
										<For each={chips(s())}>{(c) => <Chip>{c}</Chip>}</For>
										<Txt class="text-[10px] text-muted-foreground">{s().installed ? "Installed" : "Not installed"}</Txt>
									</div>
								</div>
								<Scroll style={{ flexGrow: 1, flexShrink: 1, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}>
									<Show when={!pvError()} fallback={<Para class="text-[13px] text-destructive">{`Preview unavailable: ${pvError()}`}</Para>}>
										<Show when={preview()} fallback={<Txt class="text-[13px] text-muted-foreground">{pvLoading() ? "Loading preview…" : ""}</Txt>}>
											{(pv) => (
												<div style={{ ...t("flex flex-col gap-1"), opacity: pvLoading() ? 0.5 : 1 }}>
													<Txt class="text-[11px] font-semibold text-muted-foreground">{pv().note ? "FOOTNOTES" : "IN-TEXT CITATIONS"}</Txt>
													<For each={pv().citations}>{(c) => <Para class="text-[13px] text-foreground">{htmlToText(c)}</Para>}</For>
													<Show when={pv().bibliography}>
														<div style={{ height: 6 }} />
														<Txt class="text-[11px] font-semibold text-muted-foreground">BIBLIOGRAPHY</Txt>
														<For each={htmlToText(pv().bibliography).split("\n")}>{(l) => <Para class="text-[13px] text-foreground">{l}</Para>}</For>
													</Show>
													<div style={{ height: 6 }} />
													<Para class="text-[11px] text-muted-foreground">
														{pv().sample ? "Built-in sample references (add items to your library to preview with them)." : props.itemKeys?.length ? "Previewed with your selected items." : "Previewed with items from your library."}
													</Para>
												</div>
											)}
										</Show>
									</Show>
								</Scroll>
								<div style={t("flex flex-row items-center gap-2 border-t px-3 py-2")}>
									<Show when={s().removable}>
										<Button variant="outline" size="sm" disabled={!!busy()} onClick={() => void doRemove()}>{confirmRemove() === s().id ? "Confirm remove" : "Remove"}</Button>
									</Show>
									<div style={{ flexGrow: 1 }} />
									<Show when={!s().installed}>
										<Button variant="outline" size="sm" disabled={!!busy()} onClick={() => void doInstall()}>{busy() === "install" ? "Installing…" : "Install"}</Button>
									</Show>
									<Button variant="primary" size="sm" disabled={!!busy() || props.value === s().id} onClick={() => void use()}>{props.value === s().id ? "In use" : busy() === "use" ? "Working…" : "Use this style"}</Button>
								</div>
							</>
						)}
					</Show>
				</div>
			</div>
			<Txt class="text-xs text-muted-foreground">{`In use: ${props.value}${total() > 0 ? ` · ${total()} style${total() === 1 ? "" : "s"} match` : ""}`}</Txt>
		</div>
	);
}
