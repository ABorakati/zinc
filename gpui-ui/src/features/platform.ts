// OS integration for the features: the native file / folder picker (GPUIX promptForPaths = GPUI prompt_for_paths), plain-text
// clipboard (src/ui `clipboard`: GPUIX writeToClipboard / readFromClipboard when the binding has them, else PowerShell),
// rich clipboard (HTML + text: GPUIX's clipboard is text only, so Windows PowerShell with a CF_HTML payload so Word gets
// formatting), and opening a URL.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClipboard } from "../shell/clipboard-win";
import { cfHtml } from "./cfhtml";
import { clipboard } from "../ui";
import { post } from "./http";

interface RendererLike {
	promptForPaths?: (o?: { files?: boolean; directories?: boolean; multiple?: boolean; prompt?: string } | null) => Promise<string[] | null>;
}

/** The window's native renderer (set by @gpuix/solid's render()). */
function renderer(): RendererLike | undefined {
	return (globalThis as Record<symbol, { renderer?: RendererLike } | undefined>)[Symbol.for("@gpuix/solid/render-host")]?.renderer;
}

/** Native file / folder picker. Resolves null when cancelled (or when no window renderer exists). */
export async function pickPaths(o: { files?: boolean; directories?: boolean; multiple?: boolean; prompt?: string } = {}): Promise<string[] | null> {
	const r = renderer();
	if (!r?.promptForPaths) return null;
	const got = await r.promptForPaths({ files: o.directories ? o.files ?? false : true, ...o });
	return got && got.length ? got : null;
}

// ---------------------------------------------------------------- clipboard

const scratch = join(tmpdir(), "zn-gpui-features");
function tmpFile(name: string, content: string): string {
	mkdirSync(scratch, { recursive: true });
	const p = join(scratch, name);
	writeFileSync(p, content, "utf8");
	return p;
}

const SET_CLIP_PS = `param([string]$TextFile,[string]$HtmlFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.DataObject
$d.SetText([IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8), [System.Windows.Forms.TextDataFormat]::UnicodeText)
if ($HtmlFile) { $d.SetData([System.Windows.Forms.DataFormats]::Html, [IO.File]::ReadAllText($HtmlFile, [Text.Encoding]::UTF8)) }
[System.Windows.Forms.Clipboard]::SetDataObject($d, $true, 5, 100)
`;

async function powershell(scriptName: string, script: string, args: string[] = []): Promise<string> {
	const file = tmpFile(scriptName, script);
	const p = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", file, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(err.trim().split("\n")[0] || `PowerShell exited with ${code}`);
	return out;
}

export { cfHtml };

export const copyText = (text: string): Promise<void> => clipboard.writeText(text);

/** HTML + plain text on the clipboard (rich paste into Word, plain paste elsewhere). */
export async function copyRich(html: string, text: string): Promise<void> {
	if (!html || process.platform !== "win32") return clipboard.writeText(text);
	// Win32 directly: no PowerShell helper, so no console window flashes up (the script below stays as a fallback)
	if (writeClipboard(text, cfHtml(html))) return;
	const t = tmpFile("clip.txt", text);
	const h = html ? tmpFile("clip.html", cfHtml(html)) : "";
	await powershell("set-clipboard.ps1", SET_CLIP_PS, h ? [t, h] : [t]);
}

export const readClipboardText = (): Promise<string> => clipboard.readText();

// ---------------------------------------------------------------- misc

/** Open a http(s) / doi URL in the user's browser (through the core, which refuses anything else). */
export const openUrl = (url: string) => post<{ ok: true }>("/api/open-url", { url });
