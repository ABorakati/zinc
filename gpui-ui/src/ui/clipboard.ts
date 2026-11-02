// Plain-text clipboard. Uses the GPUIX renderer's writeToClipboard / readFromClipboard when the installed binding has them
// (newer than 0.11.0), otherwise the Windows shell (clip via PowerShell Set-Clipboard / Get-Clipboard).
import { native } from "./core";

type ClipNative = { writeToClipboard?: (s: string) => void; readFromClipboard?: () => string | null | Promise<string | null> };
const nat = () => native() as unknown as ClipNative | undefined;

async function ps(args: string[], stdin?: string): Promise<string> {
	const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "ignore" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out;
}

export const clipboard = {
	/** Put plain text on the clipboard. */
	async writeText(text: string): Promise<void> {
		const n = nat();
		if (n?.writeToClipboard) { n.writeToClipboard(text); return; }
		await ps(["Set-Clipboard -Value ([Console]::In.ReadToEnd())"], text);
	},
	/** The clipboard's text ("" when it holds none). */
	async readText(): Promise<string> {
		const n = nat();
		if (n?.readFromClipboard) return (await n.readFromClipboard()) ?? "";
		return (await ps(["[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])).replace(/\r?\n$/, "");
	},
};
