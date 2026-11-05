// Tools > Import from Mendeley…: lists the Mendeley Desktop libraries found on this computer and imports the chosen one.
// The online Mendeley Reference Manager (its OAuth API) is a different product and is not supported.
import { createSignal, For, Show, type JSX } from "solid-js";
import { basename } from "node:path";
import { Button, openDialog } from "../../ui";
import { Choice, ErrorLine, Footer, Line, Para, Scroll, Txt } from "../kit";
import { pickPaths } from "../platform";
import { errMsg } from "../text";
import { importFromMendeley, ioApi, type MendeleyDatabase } from "./client";

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const when = (iso: string) => (iso ? iso.slice(0, 10) : "");

function MendeleyDialog(p: { close: () => void }): JSX.Element {
	const [databases, setDatabases] = createSignal<MendeleyDatabase[]>([]);
	const [selected, setSelected] = createSignal<string | null>(null);
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [loaded, setLoaded] = createSignal(false);

	async function load() {
		try {
			const r = await ioApi.mendeley.list();
			setDatabases(r.databases);
			setSelected(r.databases[0]?.path ?? null);
		} catch (e) {
			setError(errMsg(e));
		} finally {
			setLoaded(true);
		}
	}
	void load();

	async function chooseFile() {
		const paths = await pickPaths({ files: true, multiple: false, prompt: "Choose a Mendeley library (.sqlite)" });
		if (!paths?.[0]) return;
		const path = paths[0];
		const known = databases().find((d) => d.path.toLowerCase() === path.toLowerCase());
		if (!known) setDatabases([...databases(), { path, account: basename(path), sizeBytes: 0, modified: "", encrypted: false, inUse: false }]);
		setSelected(path);
	}

	async function submit() {
		const path = selected();
		if (!path || busy()) return;
		setBusy(true);
		const ok = await importFromMendeley(path);
		setBusy(false);
		if (ok) p.close();
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
			<Para class="text-sm text-muted-foreground">
				Items, authors, tags, folders, notes and file links are copied from a Mendeley Desktop library. The online
				Mendeley Reference Manager is not supported.
			</Para>
			<Show
				when={!loaded() || databases().length > 0}
				fallback={<Para class="text-sm text-muted-foreground">No Mendeley Desktop library was found on this computer.</Para>}
			>
				<Scroll height={220} border>
					<For each={databases()}>
						{(d) => (
							<Choice
								selected={selected() === d.path}
								label={d.account.length > 20 ? `${d.account.slice(0, 18)}…` : d.account}
								hint={[d.sizeBytes ? kb(d.sizeBytes) : "", when(d.modified), d.encrypted ? "encrypted (read and decrypted)" : "", d.inUse ? "Mendeley is running" : ""].filter(Boolean).join(" · ")}
								onClick={() => setSelected(d.path)}
							/>
						)}
					</For>
				</Scroll>
				<Show when={databases().length > 0}>
					<Line class="text-xs text-muted-foreground">{databases().find((d) => d.path === selected())?.path ?? ""}</Line>
				</Show>
			</Show>
			<ErrorLine>{error()}</ErrorLine>
			<Footer left={<Button variant="outline" size="sm" onClick={() => void chooseFile()}>Choose database…</Button>}>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
				<Button variant="primary" size="sm" disabled={busy() || !selected()} onClick={() => void submit()}>
					{busy() ? "Importing…" : "Import"}
				</Button>
			</Footer>
			<Txt class="text-xs text-muted-foreground">The library file is opened read-only; zotero-next copies nothing back into Mendeley.</Txt>
		</div>
	);
}

export const openMendeleyImport = (): Promise<void | undefined> =>
	openDialog<void>((close) => <MendeleyDialog close={() => close()} />, { title: "Import from Mendeley Desktop", width: 520 });
