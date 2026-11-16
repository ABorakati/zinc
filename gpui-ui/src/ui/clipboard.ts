// Plain-text clipboard. Uses the GPUIX renderer's writeToClipboard / readFromClipboard when the installed binding has them
// (newer than 0.11.0), else Win32 directly (shell/clipboard-win.ts: no helper process, so no console window), and only as a
// last resort PowerShell Set-Clipboard / Get-Clipboard (hidden window).
import { readClipboard, writeClipboard } from "../shell/clipboard-win";
import { native } from "./core";

type ClipNative = { writeToClipboard?: (s: string) => void; readFromClipboard?: () => string | null | Promise<string | null> };
const nat = () => native() as unknown as ClipNative | undefined;

async function ps(args: string[], stdin?: string): Promise<string> {
	const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", ...args], {
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "ignore",
		windowsHide: true,
	});
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out;
}

export const clipboard = {
	/** Put plain text on the clipboard. */
	async writeText(text: string): Promise<void> {
		const n = nat();
		if (n?.writeToClipboard) {
			n.writeToClipboard(text);
			return;
		}
		if (writeClipboard(text)) return;
		await ps(["Set-Clipboard -Value ([Console]::In.ReadToEnd())"], text);
	},
	/** The clipboard's text ("" when it holds none). */
	async readText(): Promise<string> {
		const n = nat();
		if (n?.readFromClipboard) return (await n.readFromClipboard()) ?? "";
		const direct = readClipboard();
		if (direct !== null) return direct;
		return (await ps(["[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])).replace(/\r?\n$/, "");
	},
};
