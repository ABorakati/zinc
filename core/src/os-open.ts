// Opening a file, a folder or a URL with the operating system's own opener. The command is an argument array that goes straight to
// the process (never a shell), and the target is checked first so that it can never be read as an option of the opener.

import { HttpError } from "./db";

export type OpenAction = "reveal" | "openFile" | "openUrl";
export type SpawnFn = (cmd: string[]) => void;

/** Windows: C:\ or \\server. Elsewhere: starts with "/". None of these can be read as an option ("-x", and on Windows "/x"). */
function isAbsolute(platform: string, path: string): boolean {
	if (path.includes("\0")) return false;
	if (platform === "win32") return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/?])/.test(path);
	return path.startsWith("/");
}

/** The command that performs `action` on `target` for this platform. Throws on a target that is not an absolute path / http(s) URL. */
export function openerArgv(platform: string, action: OpenAction, target: string): string[] {
	if (typeof target !== "string" || !target) throw new HttpError(400, "nothing to open");
	if (action === "openUrl") {
		if (!/^https?:\/\//i.test(target) || /[\u0000-\u001f\u007f\s]/.test(target)) throw new HttpError(400, "only http and https URLs can be opened");
		if (platform === "win32") return ["rundll32.exe", "url.dll,FileProtocolHandler", target];
		if (platform === "darwin") return ["open", target];
		return ["xdg-open", target];
	}
	if (!isAbsolute(platform, target)) throw new HttpError(400, "a full path is needed");
	if (platform === "win32") return action === "reveal" ? ["explorer.exe", "/select,", target] : ["explorer.exe", target];
	if (platform === "darwin") return action === "reveal" ? ["open", "-R", target] : ["open", target];
	// no call that selects a file is common to the Linux desktops: show the folder that holds it
	if (action === "reveal") return ["xdg-open", target.slice(0, target.lastIndexOf("/")) || "/"];
	return ["xdg-open", target];
}

const defaultSpawn: SpawnFn = (cmd) => {
	try {
		Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		// the opener program is missing (no xdg-open in a minimal Linux install, say)
		throw new HttpError(501, `this system has no "${cmd[0]}" to open it with`);
	}
};

/** Runs the platform's opener. `spawn` and `platform` are replaceable for tests. */
export function openWithSystem(action: OpenAction, target: string, spawn: SpawnFn = defaultSpawn, platform: string = process.platform): void {
	spawn(openerArgv(platform, action, target));
}

export interface Opener {
	reveal(path: string): void; // show the file in the file manager
	openFile(path: string): void; // open with the default app
	openUrl(url: string): void; // open in the default browser
}

/** The opener of this system (or of `platform`, for tests, with an injected `spawn`). */
export function systemOpener(spawn: SpawnFn = defaultSpawn, platform: string = process.platform): Opener {
	return {
		reveal: (path) => openWithSystem("reveal", path, spawn, platform),
		openFile: (path) => openWithSystem("openFile", path, spawn, platform),
		openUrl: (url) => openWithSystem("openUrl", url, spawn, platform),
	};
}
