// Plain-text clipboard. Uses the GPUIX renderer's writeToClipboard / readFromClipboard when the installed binding has them
// (newer than 0.11.0), else Win32 directly (shell/clipboard-win.ts: no helper process, so no console window), and only as a
// last resort a helper program of the platform: PowerShell Set-Clipboard / Get-Clipboard (hidden window) on Windows, pbcopy /
// pbpaste on macOS, wl-copy / xclip / xsel on Linux.
//
// Both methods return a promise that rejects when nothing could do the job, so a caller that awaits can tell. A caller that does
// not await (`void clipboard.writeText(text)`) gets no unhandled rejection from it.
import { readClipboard, writeClipboard } from "../shell/clipboard-win";
import { native } from "./core";

type ClipNative = { writeToClipboard?: (s: string) => void; readFromClipboard?: () => string | null | Promise<string | null> };

/** Run a program: `stdin` is fed to it; `wantOut` collects its stdout (a writer must not: xclip / wl-copy keep it open while they own the clipboard). */
export type Run = (argv: string[], stdin?: string, wantOut?: boolean) => Promise<{ code: number; out: string }>;

export interface ClipDeps {
	native: () => ClipNative | undefined;
	writeWin32: (text: string) => boolean;
	readWin32: () => string | null;
	run: Run;
	platform: NodeJS.Platform;
}

interface Helper {
	argv: string[];
	/** PowerShell ends what it prints with a line break that is not part of the clipboard. */
	dropFinalNewline?: boolean;
}

const PS = ["powershell", "-NoProfile", "-NonInteractive", "-Command"];

/** The helper programs to try, in order, for the platform. */
export function clipboardHelpers(platform: NodeJS.Platform): { write: Helper[]; read: Helper[] } {
	if (platform === "win32")
		return {
			write: [{ argv: [...PS, "Set-Clipboard -Value ([Console]::In.ReadToEnd())"] }],
			read: [{ argv: [...PS, "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"], dropFinalNewline: true }],
		};
	if (platform === "darwin") return { write: [{ argv: ["pbcopy"] }], read: [{ argv: ["pbpaste"] }] };
	return {
		write: [{ argv: ["wl-copy"] }, { argv: ["xclip", "-selection", "clipboard"] }, { argv: ["xsel", "--clipboard", "--input"] }],
		read: [{ argv: ["wl-paste", "--no-newline"] }, { argv: ["xclip", "-selection", "clipboard", "-o"] }, { argv: ["xsel", "--clipboard", "--output"] }],
	};
}

const defaultRun: Run = async (argv, stdin, wantOut) => {
	const p = Bun.spawn(argv, {
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: wantOut ? "pipe" : "ignore",
		stderr: "ignore",
		windowsHide: true,
	});
	const out = wantOut ? await new Response(p.stdout as ReadableStream).text() : "";
	return { code: await p.exited, out };
};

/** A promise that rejects for whoever awaits it but never counts as an unhandled rejection when nobody does. */
function quiet<T>(p: Promise<T>): Promise<T> {
	p.catch(() => {});
	return p;
}

export function makeClipboard(d: ClipDeps) {
	const helpers = clipboardHelpers(d.platform);
	return {
		/** Put plain text on the clipboard. */
		writeText(text: string): Promise<void> {
			return quiet(
				(async () => {
					const n = d.native();
					if (n?.writeToClipboard) {
						n.writeToClipboard(text);
						return;
					}
					if (d.writeWin32(text)) return;
					for (const h of helpers.write) {
						try {
							if ((await d.run(h.argv, text)).code === 0) return;
						} catch {
							/* not installed: the next one */
						}
					}
					throw new Error(`no clipboard available (tried ${helpers.write.map((h) => h.argv[0]).join(", ")})`);
				})(),
			);
		},
		/** The clipboard's text ("" when it holds none). */
		readText(): Promise<string> {
			return quiet(
				(async () => {
					const n = d.native();
					if (n?.readFromClipboard) return (await n.readFromClipboard()) ?? "";
					const direct = d.readWin32();
					if (direct !== null) return direct;
					let ran = false;
					for (const h of helpers.read) {
						try {
							const r = await d.run(h.argv, undefined, true);
							ran = true;
							if (r.code === 0) return h.dropFinalNewline ? r.out.replace(/\r?\n$/, "") : r.out;
						} catch {
							/* not installed: the next one */
						}
					}
					if (ran) return ""; // a helper answered but had no text to give
					throw new Error(`no clipboard available (tried ${helpers.read.map((h) => h.argv[0]).join(", ")})`);
				})(),
			);
		},
	};
}

export const clipboard = makeClipboard({
	native: () => native() as unknown as ClipNative | undefined,
	writeWin32: writeClipboard,
	readWin32: readClipboard,
	run: defaultRun,
	platform: process.platform,
});
