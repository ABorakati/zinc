// OS hooks for the Zinc-process handlers (`clipboard`, `shell`). The app (GPUI) can replace each with the real thing: its own clipboard,
// a confirmation dialog, the window focus check. Defaults are conservative: text-only clipboard through the platform's own tool,
// URL launch through the OS opener with an argv array (no shell), and every confirmation denied.
import { spawn } from "node:child_process";

// ------------------------------------------------------------------------------------------------ clipboard
export interface ClipboardContent {
	text?: string;
	html?: string;
	imagePng?: Uint8Array;
}

export interface ClipboardBackend {
	write(c: ClipboardContent): Promise<void>;
	read(): Promise<ClipboardContent>;
	/** Is a Zinc window focused? `clipboard.read` needs one. Default: false (refused). */
	windowFocused(): boolean;
	/** The user confirms the first read of the session. Default: denied. */
	confirmRead(pluginId: string): Promise<boolean>;
}

function run(cmd: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("error", reject);
		p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd[0]} exited ${code}`))));
		p.stdin.end(input ?? "");
	});
}

const platformClipboard: Pick<ClipboardBackend, "write" | "read"> = {
	async write(c) {
		if (c.html !== undefined || c.imagePng !== undefined) {
			if (c.text === undefined) throw new Error("this build can only put text on the clipboard");
		}
		const text = c.text ?? "";
		if (process.platform === "win32") await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t"], text);
		else if (process.platform === "darwin") await run(["pbcopy"], text);
		else await run(["sh", "-c", "wl-copy || xclip -selection clipboard"], text);
	},
	async read() {
		let text: string;
		if (process.platform === "win32") text = (await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"])).replace(/\r?\n$/, "");
		else if (process.platform === "darwin") text = await run(["pbpaste"]);
		else text = await run(["sh", "-c", "wl-paste || xclip -selection clipboard -o"]);
		return { text };
	},
};

let clipboard: ClipboardBackend = { ...platformClipboard, windowFocused: () => false, confirmRead: async () => false };
export const setClipboardBackend = (b: Partial<ClipboardBackend> | undefined): void => {
	clipboard = b ? { ...clipboard, ...b } : { ...platformClipboard, windowFocused: () => false, confirmRead: async () => false };
};
export const getClipboardBackend = (): ClipboardBackend => clipboard;

// ----------------------------------------------------------------------------------------------------- shell
export interface ShellBackend {
	/** Hand a validated URL to the OS. */
	openUrl(url: string): Promise<void>;
	/** Open a file the plugin may reach (already validated: not a program). */
	openFile(path: string): Promise<void>;
	reveal(path: string): Promise<void>;
	/** The user confirms the first use of a custom scheme by a plugin. Default: denied. */
	confirmScheme(pluginId: string, scheme: string, url: string): Promise<boolean>;
}

function detach(cmd: string[]): Promise<void> {
	// argv straight to the OS, never through a shell
	return new Promise((resolve, reject) => {
		const p = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true, windowsHide: false });
		p.on("error", reject);
		p.unref();
		setTimeout(resolve, 50);
	});
}

const platformShell: ShellBackend = {
	openUrl: (url) => (process.platform === "win32" ? detach(["rundll32.exe", "url.dll,FileProtocolHandler", url]) : detach([process.platform === "darwin" ? "open" : "xdg-open", url])),
	openFile: (path) => (process.platform === "win32" ? detach(["explorer.exe", path]) : detach([process.platform === "darwin" ? "open" : "xdg-open", path])),
	reveal: (path) => (process.platform === "win32" ? detach(["explorer.exe", `/select,${path}`]) : process.platform === "darwin" ? detach(["open", "-R", path]) : detach(["xdg-open", path])),
	confirmScheme: async () => false,
};

let shell: ShellBackend = platformShell;
export const setShellBackend = (b: Partial<ShellBackend> | undefined): void => {
	shell = b ? { ...shell, ...b } : platformShell;
};
export const getShellBackend = (): ShellBackend => shell;
