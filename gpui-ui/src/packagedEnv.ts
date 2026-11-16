// Telling a packaged Zinc's environment overrides from what a previous Zinc left behind. The packaged app points ZN_PDF_DLL, ZN_ROOT,
// ZN_READER_HOST etc. at its own files (packaged.ts) but keeps a value that is already set, so a user override wins. A self-update
// relaunches the new version from the old one (the installer inherits the old process's environment), so those variables arrived
// set to the OLD install's files: after an update into another folder, the new app loaded the old folder's zn_pdf.dll / pdfium.dll.
// A value that lies inside another Zinc package folder is such a leftover and is replaced; any other value is the user's.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Names of the packaged app's executable (Windows, Linux AppImage / macOS bundle). */
export const APP_EXE_NAMES = ["zotero-next-gpui.exe", "zotero-next-gpui"];

/**
 * The Zinc package folder a path lies in: the nearest folder above it that holds the app's executable (or, for a macOS bundle's
 * Resources, the Contents folder whose MacOS holds it). null when the path is not inside a Zinc package.
 */
type Exists = (path: string) => boolean;

export function packageRootOf(p: string, exeNames: readonly string[] = APP_EXE_NAMES, exists: Exists = existsSync): string | null {
	let d = dirname(resolve(p));
	for (let i = 0; i < 8; i++) {
		if (exeNames.some((n) => exists(join(d, n)))) return d;
		if (exeNames.some((n) => exists(join(d, "MacOS", n)))) return join(d, "MacOS");
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return null;
}

const same = (a: string, b: string) =>
	process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** True when an inherited value points into a Zinc package other than the one in `ownExeDir`: a previous version's leftover. */
export function leftByOtherPackage(
	value: string,
	ownExeDir: string,
	exeNames: readonly string[] = APP_EXE_NAMES,
	exists: Exists = existsSync,
): boolean {
	const root = packageRootOf(value, exeNames, exists);
	return root !== null && !same(root, ownExeDir);
}
