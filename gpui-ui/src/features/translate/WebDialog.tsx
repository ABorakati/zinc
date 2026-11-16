// "Add from URL…": a URL field, then (when the page offers several results) a pick-list. Saving goes through the core's translators.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Button, Checkbox, openDialog, TextInput, toast } from "../../ui";
import { ErrorLine, Footer, Para, Scroll, t } from "../kit";
import { autoAttachPdfs } from "../../settings/generalPrefs";
import { findFullText } from "../fulltext/jobs";
import { currentCollection, refresh, selectOnly } from "../shared";
import { errMsg } from "../text";
import { translateApi } from "./client";
import { allKeys, initialChecked, normaliseUrl, selectedKeys, summarise, toggleKey, type SavedItem, type WebChoices } from "./logic";

function done(items: SavedItem[], fallback?: string): void {
	refresh();
	const s = summarise(items);
	const note =
		fallback === "webpage"
			? "No translator matched; saved as a web page."
			: fallback === "embedded"
				? "Read from the page's embedded metadata."
				: "";
	toast(s.title, { kind: "success", description: [s.description, note].filter(Boolean).join("\n") || undefined, durationMs: 6000 });
	if (items[0]) selectOnly(items[0].key);
	if (items.length && autoAttachPdfs()) findFullText(items.map((i) => i.key));
}

function WebDialog(p: { initial: string; close: () => void }): JSX.Element {
	const [url, setUrl] = createSignal(p.initial);
	const [busy, setBusy] = createSignal(false);
	const [err, setErr] = createSignal("");
	const [choices, setChoices] = createSignal<WebChoices | null>(null);
	const [checked, setChecked] = createSignal(new Set<string>());

	async function submit() {
		if (!url().trim() || busy()) return;
		setBusy(true);
		setErr("");
		try {
			const r = await translateApi.web(normaliseUrl(url()), currentCollection());
			if (r.kind === "choices") {
				setChoices(r.choices);
				setChecked(initialChecked(r.choices.items));
			} else {
				done(r.saved.items, r.saved.fallback);
				p.close();
			}
		} catch (e) {
			setErr(errMsg(e));
		} finally {
			setBusy(false);
		}
	}

	async function confirm() {
		const c = choices();
		if (!c || busy()) return;
		const keys = selectedKeys(c.items, checked());
		if (!keys.length) return;
		setBusy(true);
		setErr("");
		try {
			const r = await translateApi.select(c.session, keys, currentCollection());
			done(r.items);
			p.close();
		} catch (e) {
			setErr(errMsg(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Show
				when={choices()}
				fallback={
					<>
						<Para class="text-sm text-muted-foreground">
							Address of an article, book or other page. The item is saved with its metadata, as the Zotero Connector would.
						</Para>
						<TextInput autofocus value={url()} onInput={setUrl} onEnter={() => void submit()} placeholder="https://…" />
						<ErrorLine>{err()}</ErrorLine>
						<Footer>
							<Button variant="outline" size="sm" onClick={p.close}>
								Cancel
							</Button>
							<Button variant="primary" size="sm" disabled={busy() || !url().trim()} onClick={() => void submit()}>
								{busy() ? "Fetching…" : "Add"}
							</Button>
						</Footer>
					</>
				}
			>
				{(c) => (
					<>
						<Para class="text-sm text-muted-foreground">{`This page lists several items. Choose the ones to add (${checked().size} of ${c().items.length} selected).`}</Para>
						<div style={t("flex flex-row items-center gap-2")}>
							<Button variant="outline" size="sm" onClick={() => setChecked(allKeys(c().items))}>
								Select all
							</Button>
							<Button variant="outline" size="sm" onClick={() => setChecked(new Set())}>
								Select none
							</Button>
						</div>
						<Scroll height={288} border>
							<For each={c().items}>
								{(i) => (
									<div style={{ ...t("flex flex-col px-2 py-1.5"), flexShrink: 0 }}>
										<Checkbox
											checked={checked().has(i.key)}
											onChange={() => setChecked(toggleKey(checked(), i.key))}
											label={i.title || "(untitled)"}
										/>
									</div>
								)}
							</For>
						</Scroll>
						<ErrorLine>{err()}</ErrorLine>
						<Footer>
							<Button variant="outline" size="sm" onClick={p.close}>
								Cancel
							</Button>
							<Button variant="primary" size="sm" disabled={busy() || !checked().size} onClick={() => void confirm()}>
								{busy() ? "Adding…" : `Add ${checked().size}`}
							</Button>
						</Footer>
					</>
				)}
			</Show>
		</div>
	);
}

export const openWebDialog = (initial = ""): Promise<void> =>
	openDialog<void>((close) => <WebDialog initial={initial} close={() => close()} />, { title: "Add from URL", width: 520 });
