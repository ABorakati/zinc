// File types that run code when the shell opens them. Used to keep web-saved attachments from keeping such an
// extension, and to stop "open externally" from launching one without an explicit confirmation.
import { extname } from "node:path";

const EXECUTABLE_EXTENSIONS = new Set([
	// native / installers
	".exe", ".com", ".scr", ".msi", ".msp", ".msix", ".appx", ".dll", ".sys", ".cpl", ".pif", ".gadget",
	// scripts and shortcuts
	".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".ps1xml", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".ws", ".hta", ".sct",
	".lnk", ".url", ".scf", ".inf", ".reg", ".rgs", ".msc", ".jar", ".jnlp", ".application", ".appref-ms", ".library-ms", ".search-ms", ".settingcontent-ms",
	// office macros
	".docm", ".dotm", ".xlsm", ".xltm", ".xlam", ".pptm", ".potm", ".ppam", ".sldm", ".xll", ".wll", ".vba",
	// unix-style
	".sh", ".bash", ".command", ".app", ".py", ".pyw", ".pl", ".rb", ".php", ".out", ".run", ".bin", ".elf",
	// other launchers
	".chm", ".iso", ".img", ".vhd", ".vhdx", ".appxbundle", ".msixbundle", ".diagcab", ".theme", ".themepack",
]);

/** The lower-cased extension of a file name as Windows sees it (trailing dots and spaces are ignored). */
export function fileExtension(name: string): string {
	return extname(name.replace(/[. ]+$/, "")).toLowerCase();
}

/** True when opening this file name through the shell could run code. */
export function isExecutableName(name: string): boolean {
	return EXECUTABLE_EXTENSIONS.has(fileExtension(name));
}

/** Append ".txt" to an executable / script file name so a saved web download can never launch; other names are unchanged. */
export function neutraliseExecutableName(name: string): string {
	return isExecutableName(name) ? `${name.replace(/[. ]+$/, "")}.txt` : name;
}
