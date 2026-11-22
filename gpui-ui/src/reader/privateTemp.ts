// Files this app leaves in the shared temp folder (the PDF handed to a print dialog, the structure cache). On Linux that folder is
// /tmp, shared with every other user: a predictable name there can be pre-created by someone else (a link that gets the file
// overwritten, or a file whose content is then read back), and a default-mode file is readable by everyone. So these helpers use a
// folder of its own that only this user can open, and files only this user can read. (Windows' and macOS's temp folders are
// per user already; the modes are no-ops on Windows.)
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `dir`, created when missing with a mode only this user can enter. Null when it already exists but is not a real folder of this user
 * (a link, or someone else's, or open to others): the caller then does without it instead of trusting what is in there.
 * `owner`: the uid that must own it; defaults to this process's (none on Windows: nothing to check there).
 */
export function privateDir(dir: string, owner: number | undefined = process.getuid?.()): string | null {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (owner === undefined) return dir;
		const st = lstatSync(dir);
		if (!st.isDirectory() || st.uid !== owner || (st.mode & 0o077) !== 0) return null;
		return dir;
	} catch {
		return null;
	}
}

/**
 * Write `bytes` as a PDF into a new folder of its own (random name, mode 0700) and return its path; `remove()` deletes the folder. The
 * file is readable by this user only, which is all the print dialog (GTK / PDFKit, in this process) and `lp` (reads it as this user)
 * need.
 */
export function writePrivateTemp(bytes: Uint8Array, prefix = "zinc-print-"): { file: string; remove(): void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const file = join(dir, "document.pdf");
	const remove = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* still in use */
		}
	};
	try {
		writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
	} catch (e) {
		remove();
		throw e;
	}
	return { file, remove };
}
