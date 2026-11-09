// The first-run screen: shown instead of the library window when no library is configured (or the configured file is gone).
// A full-window page with three ways to get a library: import it from Zotero (with progress), open an existing zotero-next library,
// or start an empty one. The choice is saved and start-up continues (run.ts).
//
// It is built from the theme directly (tw / textStyle with a fixed mode), NOT from ../ui or ../shell/kit: those import the store,
// and creating the store starts loading a library that does not exist yet. GPUIX quirks followed here: every clickable box is
// filled (an unfilled box gets no hit area), one string child per <text>, and hover styles go through the tw classes.
import { createSignal, onMount, Show, type JSX } from "solid-js";
import type { Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { shadows, textStyle, tokens, tw } from "../theme";
import { canImport, describeZotero, progressFraction, progressText, type ImportProgress, type ZoteroFound } from "./logic";

/** What the screen needs from the app. run.ts supplies the real one; scripts/shot-firstrun.tsx a mock. */
export interface FirstRunApi {
	/** Where a new library will be created (shown, and used by createEmpty / importFromZotero). */
	defaultPath: string;
	/** Why this screen is showing when it is not simply a first start (e.g. the saved library file is missing). */
	notice?: string;
	/** A native file / folder dialog exists (a real window). */
	canPick: boolean;
	/** The Zotero data folder Zotero itself uses, or null when none is found. */
	detectZotero(): Promise<ZoteroFound | null>;
	/** Folder dialog, then the chosen folder inspected; null when cancelled. */
	pickZoteroFolder(): Promise<ZoteroFound | null>;
	/** Import into a new library at the default location; resolves to its path. */
	importFromZotero(dir: string, onProgress: (p: ImportProgress) => void): Promise<string>;
	/** File dialog, then the file checked; null when cancelled. */
	pickLibrary(): Promise<{ path: string } | { problem: string } | null>;
	/** Create the (empty) library folder; resolves to the path the core will create the database at. */
	createEmpty(): Promise<string>;
	/** The choice is made: save it and continue the start-up. */
	done(path: string): void;
}

type Stage = "choose" | "importing";

export function FirstRun(p: { api: FirstRunApi; mode: Mode }): JSX.Element {
	const { api } = p;
	const t = (cls: string): Style => tw(cls, p.mode);
	const tx = (cls: string): Style => textStyle(cls, p.mode);
	const tok = (name: string): string => tokens[p.mode][name] ?? "#888888";

	const [zotero, setZotero] = createSignal<ZoteroFound | null | undefined>(undefined); // undefined: still looking
	const [stage, setStage] = createSignal<Stage>("choose");
	const [progress, setProgress] = createSignal<ImportProgress | null>(null);
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);

	onMount(() => {
		api.detectZotero().then(setZotero, () => setZotero(null));
	});

	const fail = (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setStage("choose"); setBusy(false); };

	async function runImport(dir: string) {
		setError("");
		setProgress(null);
		setStage("importing");
		setBusy(true);
		try {
			const path = await api.importFromZotero(dir, setProgress);
			api.done(path);
		} catch (e) { fail(e); }
	}

	async function chooseFolder(): Promise<ZoteroFound | null> {
		if (!api.canPick) { setError("There is no folder dialog in this window."); return null; }
		const z = await api.pickZoteroFolder();
		if (z) setZotero(z);
		return z;
	}

	async function onImport() {
		if (busy()) return;
		setError("");
		let z = zotero();
		if (!canImport(z ?? null)) {
			// nothing usable found: ask for the folder, and go on straight away when it is a Zotero library
			setBusy(true);
			try { z = await chooseFolder(); } catch (e) { fail(e); return; }
			setBusy(false);
			if (!z) return;
			if (!canImport(z)) { setError(describeZotero(z)); return; }
		}
		await runImport(z!.dir);
	}

	async function onOpen() {
		if (busy()) return;
		setError("");
		if (!api.canPick) { setError("There is no file dialog in this window."); return; }
		setBusy(true);
		try {
			const r = await api.pickLibrary();
			if (!r) { setBusy(false); return; }
			if ("problem" in r) { setError(r.problem); setBusy(false); return; }
			api.done(r.path);
		} catch (e) { fail(e); }
	}

	async function onEmpty() {
		if (busy()) return;
		setError("");
		setBusy(true);
		try { api.done(await api.createEmpty()); } catch (e) { fail(e); }
	}

	// ---- pieces

	const Txt = (q: { cls: string; children: string; style?: Style }): JSX.Element => <text style={{ ...tx(q.cls), ...q.style }}>{q.children}</text>;
	/** A path on one line; when it does not fit, the start is cut (the end of a path is the informative part). */
	const PathLine = (q: { children: string; cls?: string }): JSX.Element => (
		<text style={{ ...tx(q.cls ?? "text-xs text-muted-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis-start", minWidth: 0, flexShrink: 1, maxWidth: "100%" }}>{q.children}</text>
	);

	/** One way to start. The whole card is the button (a filled box, so it has a hit area). */
	function Choice(q: { icon: string; title: string; text: string; detail?: () => string; detailTone?: () => "ok" | "warn"; path?: () => string | undefined; action: string; primary?: boolean; onClick: () => void }): JSX.Element {
		return (
			<div
				onClick={q.onClick}
				style={{
					...t("flex items-center gap-4 rounded-[14px] bg-background p-4 hover:bg-accent"),
					boxShadow: shadows[p.mode].raised,
					cursor: busy() ? "default" : "pointer",
					opacity: busy() ? 0.6 : 1,
					width: "100%",
				}}
			>
				<div style={{ ...t("flex items-center justify-center rounded-full bg-muted"), width: 44, height: 44, flexShrink: 0 }}>
					<Icon name={q.icon} size={20} color={tok(q.primary ? "primary" : "foreground")} />
				</div>
				<div style={{ ...t("flex flex-col gap-1"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
					<Txt cls="text-[15px] font-semibold text-foreground">{q.title}</Txt>
					<Txt cls="text-xs text-muted-foreground">{q.text}</Txt>
					<Show when={q.detail?.()}>
						<Txt cls={`text-xs ${q.detailTone?.() === "warn" ? "text-warning-foreground" : "text-foreground"}`}>{q.detail!()}</Txt>
					</Show>
					<Show when={q.path?.()}>
						<PathLine>{q.path!()!}</PathLine>
					</Show>
				</div>
				<div
					style={{
						...t(`flex flex-none items-center justify-center rounded-md h-8 px-3.5 ${q.primary ? "bg-primary" : "bg-secondary"}`),
						...(q.primary ? { boxShadow: shadows[p.mode].primary } : {}),
					}}
				>
					<text style={{ ...tx("text-[13px] font-medium"), color: tok(q.primary ? "primary-foreground" : "secondary-foreground"), whiteSpace: "nowrap" }}>{q.action}</text>
				</div>
			</div>
		);
	}

	const zoteroDetail = (): string => {
		const z = zotero();
		if (z === undefined) return "Looking for Zotero…";
		if (!z) return "Zotero was not found; you will be asked for its data folder.";
		return describeZotero(z);
	};
	const zoteroPath = (): string | undefined => zotero()?.dir;

	const pct = () => `${Math.round(progressFraction(progress()) * 100)}%`;

	return (
		<div style={{ ...t("flex flex-col items-center justify-center bg-canvas"), width: "100%", height: "100%" }}>
			<div style={{ ...t("flex flex-col gap-5"), width: "100%", maxWidth: 660, padding: 24 }}>
				<div style={t("flex flex-col gap-1.5")}>
					<Txt cls="text-[26px] font-semibold text-foreground" style={{ fontFamily: "Source Serif 4" }}>Welcome to Zinc</Txt>
					<Txt cls="text-sm text-muted-foreground">Choose where your library comes from. You can change this later in Settings, under Files and folders.</Txt>
				</div>

				<Show when={api.notice}>
					<div style={{ ...t("flex flex-col gap-1 rounded-md bg-warning p-2.5"), width: "100%" }}>
						<Txt cls="text-xs text-warning-foreground">{api.notice!}</Txt>
					</div>
				</Show>

				<Show when={stage() === "choose"}>
					<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
						<Choice
							icon="import" title="Import from Zotero" primary action="Import"
							text="Copy your Zotero library into a new Zinc library. Zotero is only read, never changed."
							detail={zoteroDetail} path={zoteroPath} detailTone={() => (zotero() && canImport(zotero() ?? null) ? "ok" : "warn")}
							onClick={() => void onImport()}
						/>
						<Choice
							icon="folder-open" title="Open an existing library…" action="Browse…"
							text="Use a Zinc library file you already have, on this computer or on a drive you moved it to."
							onClick={() => void onOpen()}
						/>
						<Choice
							icon="plus" title="Start an empty library" action="Start"
							text="Begin with nothing and add papers, or import files later."
							onClick={() => void onEmpty()}
						/>
					</div>
					<Show when={zotero() && api.canPick}>
						<div style={t("flex items-center gap-2")}>
							<div
								onClick={() => { if (!busy()) void chooseFolder().then((z) => z && setError(canImport(z) ? "" : describeZotero(z))); }}
								style={{ ...t("flex flex-none items-center rounded-md bg-muted px-2.5 h-7 hover:bg-accent"), cursor: "pointer" }}
							>
								<text style={{ ...tx("text-xs font-medium text-foreground"), whiteSpace: "nowrap" }}>Use a different Zotero folder…</text>
							</div>
						</div>
					</Show>
				</Show>

				<Show when={stage() === "importing"}>
					<div style={{ ...t("flex flex-col gap-3 rounded-[14px] bg-background p-5"), boxShadow: shadows[p.mode].raised, width: "100%" }}>
						<Txt cls="text-[15px] font-semibold text-foreground">Importing from Zotero</Txt>
						<Txt cls="text-xs text-muted-foreground">{progressText(progress())}</Txt>
						<div style={{ ...t("rounded-full bg-muted"), width: "100%", height: 8, overflow: "hidden" }}>
							<div style={{ ...t("rounded-full bg-primary"), width: pct(), height: 8 }} />
						</div>
						<Txt cls="text-xs text-muted-foreground">This can take a few minutes for a large library. Keep this window open.</Txt>
					</div>
				</Show>

				<Show when={error()}>
					<div style={{ ...t("flex flex-col gap-1 rounded-md bg-destructive/10 p-2.5"), width: "100%" }}>
						<Txt cls="text-xs text-destructive">{error()}</Txt>
					</div>
				</Show>

				<div style={{ ...t("flex items-center gap-1.5"), width: "100%", minWidth: 0 }}>
					<Txt cls="text-xs text-muted-foreground" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>A new library is created at</Txt>
					<PathLine>{api.defaultPath}</PathLine>
				</div>
			</div>
		</div>
	);
}
