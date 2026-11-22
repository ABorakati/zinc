// File types that run code when the shell opens them. Used to keep web-saved attachments from keeping such an
// extension, and to stop "open externally" from launching one without an explicit confirmation.
import { statSync } from "node:fs";
import { extname } from "node:path";

const EXECUTABLE_EXTENSIONS = new Set([
	// native / installers
	".exe",
	".com",
	".scr",
	".msi",
	".msp",
	".msix",
	".appx",
	".dll",
	".sys",
	".cpl",
	".pif",
	".gadget",
	// scripts and shortcuts
	".bat",
	".cmd",
	".ps1",
	".psm1",
	".psd1",
	".ps1xml",
	".vbs",
	".vbe",
	".js",
	".jse",
	".wsf",
	".wsh",
	".ws",
	".hta",
	".sct",
	".lnk",
	".url",
	".scf",
	".inf",
	".reg",
	".rgs",
	".msc",
	".jar",
	".jnlp",
	".application",
	".appref-ms",
	".library-ms",
	".search-ms",
	".settingcontent-ms",
	// office macros
	".docm",
	".dotm",
	".xlsm",
	".xltm",
	".xlam",
	".pptm",
	".potm",
	".ppam",
	".sldm",
	".xll",
	".wll",
	".vba",
	// unix-style
	".sh",
	".bash",
	".command",
	".app",
	".py",
	".pyw",
	".pl",
	".rb",
	".php",
	".out",
	".run",
	".bin",
	".elf",
	".zsh",
	".csh",
	".ksh",
	".fish",
	".tool",
	// what macOS `open` and Linux `xdg-open` launch or install
	".desktop",
	".appimage",
	".flatpakref",
	".deb",
	".rpm",
	".terminal",
	".fileloc",
	".inetloc",
	".webloc",
	".workflow",
	".action",
	".scpt",
	".scptd",
	".applescript",
	".pkg",
	".mpkg",
	".dmg",
	".prefpane",
	".mobileconfig",
	// other launchers
	".chm",
	".iso",
	".img",
	".vhd",
	".vhdx",
	".appxbundle",
	".msixbundle",
	".diagcab",
	".theme",
	".themepack",
]);

/** The lower-cased extension of a file name as Windows sees it (trailing dots and spaces are ignored). */
export function fileExtension(name: string): string {
	return extname(name.replace(/[. ]+$/, "")).toLowerCase();
}

/** True when opening this file name through the shell could run code. */
export function isExecutableName(name: string): boolean {
	return EXECUTABLE_EXTENSIONS.has(fileExtension(name));
}

/**
 * True when handing this file to the system's opener could run code: its name says so, or (macOS, Linux) it is a file with no extension
 * (or only a version number) and has an executable bit, which `open` runs as a program.
 */
export function opensAsProgram(
	path: string,
	platform: string = process.platform,
	modeOf: (path: string) => number = (p) => statSync(p).mode,
): boolean {
	if (isExecutableName(path)) return true;
	const ext = fileExtension(path);
	if (platform === "win32" || (ext && !/^.d+$/.test(ext))) return false;
	try {
		const mode = modeOf(path);
		return (mode & 0o170000) !== 0o040000 && (mode & 0o111) !== 0; // a folder's bit only means it can be entered
	} catch {
		return true; // it cannot be checked: ask first
	}
}

/** Append ".txt" to an executable / script file name so a saved web download can never launch; other names are unchanged. */
export function neutraliseExecutableName(name: string): string {
	return isExecutableName(name) ? `${name.replace(/[. ]+$/, "")}.txt` : name;
}
