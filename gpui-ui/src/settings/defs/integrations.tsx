// Integrations: the Word add-in and the browser connector (Edge / Chrome), installed per user by the core
// (/api/integrations, the scripts in the repo), like Zotero's own buttons.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Txt, t } from "../../shell/kit";
import { call, errMsg } from "../../shell/net";
import { toast } from "../../ui";
import { Btn, Value } from "../controls";
import { onSettingsShown, registerSection, registerSettings } from "../registry";

registerSection({
	id: "integrations", label: "Integrations", icon: "plug", order: 88,
	description: "Word, and saving from your browser.",
	keywords: ["word", "office", "edge", "chrome", "browser", "connector", "extension", "add-in"],
});

interface IntegrationsStatus {
	word: { installed: boolean; available: boolean; wordRunning: boolean; problem?: string };
	chrome: {
		hostInstalled: boolean; available: boolean; extensionDir: string; problem?: string;
		chromeFound: boolean; edgeFound: boolean; chromeHost: boolean; edgeHost: boolean;
	};
}

const [status, setStatus] = createSignal<IntegrationsStatus | null>(null);
const [busy, setBusy] = createSignal<string | null>(null);
const [failed, setFailed] = createSignal(false);
const refresh = () => void call<IntegrationsStatus>("GET", "/api/integrations").then((s) => { setStatus(s); setFailed(false); }, () => { setStatus(null); setFailed(true); });
onSettingsShown(refresh);

async function act(what: "word" | "chrome", action: "install" | "uninstall", done: string): Promise<boolean> {
	setBusy(`${what}.${action}`);
	try {
		const r = await call<{ status: IntegrationsStatus }>("POST", `/api/integrations/${what}/${action}`);
		setStatus(r.status);
		toast(done, { kind: "success" });
		return true;
	} catch (e) {
		toast(action === "install" ? "Could not install" : "Could not uninstall", { kind: "error", description: errMsg(e) });
		return false;
	} finally { setBusy(null); }
}

const checking = (): JSX.Element => <Value>{failed() ? "The core is not reachable." : "Checking…"}</Value>;
const OkText = (p: { children: string }): JSX.Element => <Txt cls="text-xs text-success-foreground">{p.children}</Txt>;

function WordControl(): JSX.Element {
	return (
		<Show when={status()} fallback={checking()}>
			{(s) => (
				<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
					<div style={t("flex flex-wrap items-center gap-1.5")}>
						<Show
							when={s().word.installed}
							fallback={
								<Btn primary disabled={!s().word.available || !!busy()} onClick={() => void act("word", "install", "Word add-in installed: open Word and look for the Zotero Next tab")}>
									{busy() === "word.install" ? "Installing…" : "Install Microsoft Word add-in"}
								</Btn>
							}
						>
							<OkText>Installed</OkText>
							<Btn disabled={!!busy()} onClick={() => void act("word", "install", "Word add-in reinstalled")}>{busy() === "word.install" ? "Reinstalling…" : "Reinstall"}</Btn>
							<Btn disabled={!!busy()} onClick={() => void act("word", "uninstall", "Word add-in removed")}>{busy() === "word.uninstall" ? "Removing…" : "Uninstall"}</Btn>
						</Show>
					</div>
					<Show when={s().word.wordRunning}><Value>Close Word before installing or removing.</Value></Show>
					<Show when={s().word.problem}><Value>{s().word.problem!}</Value></Show>
				</div>
			)}
		</Show>
	);
}

type Browser = "edge" | "chrome";
const NAME: Record<Browser, string> = { edge: "Edge", chrome: "Chrome" };

function ChromeControl(): JSX.Element {
	const open = (b: Browser) => void call<{ opened: boolean }>("POST", `/api/integrations/chrome/open?browser=${b}`).then(
		(r) => toast(r.opened ? `In ${NAME[b]}: turn on Developer mode, click Load unpacked, choose the folder that just opened` : `${NAME[b]} was not found: open ${b}://extensions yourself`, { kind: "info", durationMs: 15000 }),
		(e) => toast(`Could not open ${NAME[b]}`, { kind: "error", description: errMsg(e) }),
	);
	/** Browsers on this PC, Edge first. */
	const browsers = (): Browser[] => {
		const s = status()?.chrome;
		const list: Browser[] = [];
		if (s?.edgeFound) list.push("edge");
		if (s?.chromeFound) list.push("chrome");
		return list.length ? list : ["edge"];
	};
	return (
		<Show when={status()} fallback={checking()}>
			{(s) => (
				<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
					<div style={t("flex flex-wrap items-center justify-end gap-1.5")}>
						<Show
							when={s().chrome.hostInstalled}
							fallback={
								<Btn primary disabled={!s().chrome.available || !!busy()} onClick={async () => { if (await act("chrome", "install", "Browser connector helper installed for Edge and Chrome")) open(browsers()[0]!); }}>
									{busy() === "chrome.install" ? "Installing…" : "Install browser connector"}
								</Btn>
							}
						>
							<OkText>Helper installed</OkText>
							<For each={browsers()}>{(b) => <Btn onClick={() => open(b)}>{`Add to ${NAME[b]}…`}</Btn>}</For>
							<Btn disabled={!!busy()} onClick={() => void act("chrome", "uninstall", "Browser connector helper removed")}>{busy() === "chrome.uninstall" ? "Removing…" : "Uninstall"}</Btn>
						</Show>
					</div>
					<Show when={s().chrome.problem}><Value>{s().chrome.problem!}</Value></Show>
				</div>
			)}
		</Show>
	);
}

registerSettings([
	{
		id: "integrations.word", section: "integrations", group: "Word processors", label: "Microsoft Word add-in",
		description: "A Zotero Next sidebar in Word: search, insert citations and a bibliography (Zotero-compatible). Works without the app open.",
		keywords: ["word", "office", "plugin", "add-in", "addin", "cite while you write", "sidebar", "citations", "install"],
		control: () => <WordControl />,
	},
	{ id: "integrations.libreoffice", section: "integrations", group: "Word processors", label: "LibreOffice and Google Docs", description: "Cite-while-you-write for LibreOffice and Google Docs.", keywords: ["libreoffice", "google docs", "plugin"], unavailable: true },
	{
		id: "integrations.connector", section: "integrations", group: "Browser", label: "Browser connector (Edge / Chrome)",
		description: "Save papers and PDFs from Edge or Chrome into this library, even when the app is closed. The browser asks you to add the extension yourself (Load unpacked).",
		keywords: ["edge", "microsoft edge", "chrome", "browser", "extension", "connector", "save to zotero", "web", "install"],
		control: () => <ChromeControl />,
	},
]);
