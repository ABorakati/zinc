// The browser library's first-run screen (docs/design/browser-edition.md, step B5): shown instead of the app while the library is empty and
// the user has not chosen how to start. It has the look and the building blocks of the desktop's first-run screen
// (src/firstrun/FirstRun.tsx): the same page, cards and progress panel, drawn from the theme (tw / textStyle).
// Three ways to start, and a note that the library lives in this browser. GPUIX quirks followed as there: every clickable box is filled
// (an unfilled box gets no hit area), one string child per <text>, hover styles through the tw classes.
import { createSignal, Show, type JSX } from "solid-js";
import type { Mode, Style } from "../../src/contracts";
import { progressFraction, progressText } from "../../src/firstrun/logic";
import { Icon } from "../../src/icons";
import { shadows, textStyle, tokens, tw } from "../../src/theme";
import type { ImportSummary, Progress } from "./welcome-import";

/** What the screen needs from the page (extension.tsx supplies the real one). */
export interface WelcomeApi {
	/** "Start with an empty library": remember the choice and show the app. */
	startEmpty(): void;
	/** "Sign in to zotero.org": remember the choice, show the app on Settings > Sync. */
	signIn(): void;
	/** The folder dialog (showDirectoryPicker); null when cancelled or there is none. */
	pickFolder(): Promise<unknown | null>;
	/** Import what was picked. */
	importFolder(handle: unknown, onProgress: (p: Progress) => void): Promise<ImportSummary>;
	/** The import finished and the user went on: remember it, show the app. */
	done(): void;
}

type Stage = "choose" | "importing" | "imported";
const n = (v: number) => v.toLocaleString("en-GB");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** Where the bar is: files going over fill the first half, the worker's phases the rest. */
export function importFraction(p: Progress | null): number {
	if (!p) return 0;
	if (p.phase === "upload")
		return p.totalBytes ? 0.45 * Math.min(1, (p.bytes ?? 0) / p.totalBytes) : p.total ? 0.45 * Math.min(1, (p.done ?? 0) / p.total) : 0;
	if (p.phase === "copy") return 0.9;
	if (p.phase === "files") return 0.95;
	if (p.phase === "finish") return 0.98;
	return 0.45 + 0.45 * progressFraction(p);
}
export function importText(p: Progress | null): string {
	if (!p) return "Starting…";
	switch (p.phase) {
		case "upload":
			return p.total
				? `Copying files from the folder: ${n(p.done ?? 0)} of ${n(p.total)}`
				: (p.message ?? "Looking through the folder…");
		case "copy":
			return "Putting the library into this browser…";
		case "files":
			return "Moving attachment files…";
		case "finish":
			return "Building the search index…";
		default:
			return progressText(p);
	}
}

export function summaryLines(s: ImportSummary): string[] {
	const out = [
		`${plural(s.topLevelItems, "item")} (${plural(s.items - s.topLevelItems, "attachment, note and annotation", "attachments, notes and annotations")} inside them), ${plural(s.collections, "collection")}.`,
	];
	if (s.fileFolders) out.push(`${plural(s.fileFolders, "attachment folder")} copied.`);
	if (s.missingFiles) out.push(`${plural(s.missingFiles, "attachment")} had no file in the folder.`);
	return [...out, ...s.warnings];
}

export function BrowserWelcome(p: { api: WelcomeApi; mode: Mode }): JSX.Element {
	const { api } = p;
	const t = (cls: string): Style => tw(cls, p.mode);
	const tx = (cls: string): Style => textStyle(cls, p.mode);
	const tok = (name: string): string => tokens[p.mode][name] ?? "#888888";

	const [stage, setStage] = createSignal<Stage>("choose");
	const [progress, setProgress] = createSignal<Progress | null>(null);
	const [summary, setSummary] = createSignal<ImportSummary | null>(null);
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);

	async function onImport() {
		if (busy()) return;
		setError("");
		setBusy(true);
		let handle: unknown | null;
		try {
			handle = await api.pickFolder();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
			return;
		}
		if (!handle) {
			setBusy(false);
			return;
		}
		setProgress(null);
		setStage("importing");
		try {
			setSummary(await api.importFolder(handle, setProgress));
			setStage("imported");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setStage("choose");
		}
		setBusy(false);
	}

	const Txt = (q: { cls: string; children: string; style?: Style }): JSX.Element => (
		<text style={{ ...tx(q.cls), ...q.style }}>{q.children}</text>
	);

	/** One way to start. The whole card is the button (a filled box, so it has a hit area). */
	function Choice(q: { icon: string; title: string; text: string; action: string; primary?: boolean; onClick: () => void }): JSX.Element {
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
				</div>
				<div
					style={{
						...t(
							`flex flex-none items-center justify-center rounded-md h-8 px-3.5 ${q.primary ? "bg-primary" : "bg-secondary"}`,
						),
						...(q.primary ? { boxShadow: shadows[p.mode].primary } : {}),
					}}
				>
					<text
						style={{
							...tx("text-[13px] font-medium"),
							color: tok(q.primary ? "primary-foreground" : "secondary-foreground"),
							whiteSpace: "nowrap",
						}}
					>
						{q.action}
					</text>
				</div>
			</div>
		);
	}

	const pct = () => `${Math.round(importFraction(progress()) * 100)}%`;

	return (
		<div style={{ ...t("flex flex-col items-center justify-center bg-canvas"), width: "100%", height: "100%" }}>
			<div style={{ ...t("flex flex-col gap-5"), width: "100%", maxWidth: 660, padding: 24 }}>
				<div style={t("flex flex-col gap-1.5")}>
					<Txt cls="text-[26px] font-semibold text-foreground" style={{ fontFamily: "Source Serif 4" }}>
						Welcome to Zinc
					</Txt>
					<Txt cls="text-sm text-muted-foreground">Choose how to start your library. You can import or sign in later too.</Txt>
				</div>

				<Show when={stage() === "choose"}>
					<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
						<Choice
							icon="plus"
							title="Start with an empty library"
							primary
							action="Start"
							text="Begin with nothing and add papers with the connector, or import files later."
							onClick={() => {
								if (!busy()) api.startEmpty();
							}}
						/>
						<Choice
							icon="log-in"
							title="Sign in to zotero.org"
							action="Sign in"
							text="Fetch your library from your Zotero account, and keep it in step. You will enter your API key in Settings, under Sync."
							onClick={() => {
								if (!busy()) api.signIn();
							}}
						/>
						<Choice
							icon="folder-open"
							title="Import a Zotero or Zinc data folder"
							action="Choose a folder…"
							text="Pick a Zotero data folder (with zotero.sqlite and storage) or a Zinc library folder (library.sqlite and storage). It is only read."
							onClick={() => void onImport()}
						/>
					</div>
				</Show>

				<Show when={stage() === "importing"}>
					<div
						style={{
							...t("flex flex-col gap-3 rounded-[14px] bg-background p-5"),
							boxShadow: shadows[p.mode].raised,
							width: "100%",
						}}
					>
						<Txt cls="text-[15px] font-semibold text-foreground">Importing your library</Txt>
						<Txt cls="text-xs text-muted-foreground">{importText(progress())}</Txt>
						<div style={{ ...t("rounded-full bg-muted"), width: "100%", height: 8, overflow: "hidden" }}>
							<div style={{ ...t("rounded-full bg-primary"), width: pct(), height: 8 }} />
						</div>
						<Txt cls="text-xs text-muted-foreground">This can take a few minutes for a large library. Keep this tab open.</Txt>
					</div>
				</Show>

				<Show when={stage() === "imported" && summary()}>
					<div
						style={{
							...t("flex flex-col gap-3 rounded-[14px] bg-background p-5"),
							boxShadow: shadows[p.mode].raised,
							width: "100%",
						}}
					>
						<Txt cls="text-[15px] font-semibold text-foreground">Your library is imported</Txt>
						{summaryLines(summary()!).map((l) => (
							<Txt cls="text-xs text-muted-foreground">{l}</Txt>
						))}
						<div style={t("flex items-center gap-2")}>
							<div
								onClick={() => api.done()}
								style={{
									...t("flex flex-none items-center justify-center rounded-md h-8 px-3.5 bg-primary hover:bg-primary"),
									boxShadow: shadows[p.mode].primary,
									cursor: "pointer",
								}}
							>
								<text style={{ ...tx("text-[13px] font-medium"), color: tok("primary-foreground"), whiteSpace: "nowrap" }}>
									Open the library
								</text>
							</div>
						</div>
					</div>
				</Show>

				<Show when={error()}>
					<div style={{ ...t("flex flex-col gap-1 rounded-md bg-destructive/10 p-2.5"), width: "100%" }}>
						<Txt cls="text-xs text-destructive">{error()}</Txt>
					</div>
				</Show>

				<div style={{ ...t("flex items-start gap-2.5 rounded-md bg-muted p-3"), width: "100%" }}>
					<Icon name="info" size={15} color={tok("muted-foreground")} />
					<text style={{ ...tx("text-xs text-muted-foreground"), flexShrink: 1, minWidth: 0 }}>
						Your library is stored in this browser. Removing the extension deletes it. Sync with zotero.org or use Export
						library to keep a copy.
					</text>
				</div>
			</div>
		</div>
	);
}
