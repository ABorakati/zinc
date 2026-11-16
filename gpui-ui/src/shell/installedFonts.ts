// The font families installed on this computer, for pickers that let the user name any font (the reading view's custom font).
// GPUIX cannot list fonts, so each OS is asked its own way: Windows through .NET's InstalledFontCollection (a PowerShell
// process, ~1 s, so it is asynchronous and cached), macOS through AppKit's NSFontManager, Linux through fontconfig's fc-list.
// An empty list means "unknown": callers then accept any name.
import { CString } from "bun:ffi";
import { objc } from "./objc";

let cached: Promise<string[]> | undefined;

/** Weight / width words Windows' older (GDI) font list appends to a family ("Cascadia Code SemiBold"); DirectWrite, which GPUI
 *  uses, knows only the family ("Cascadia Code"), so such names are dropped when their family is listed too. */
const STYLE =
	/\s+(?:(?:Extra|Ultra|Semi|Demi)?(?:Light|Bold|Condensed|Expanded)|Thin|Hairline|Medium|Black|Heavy|Book|Narrow|Regular|SemiLight)$/i;

export function tidy(names: Iterable<string>): string[] {
	const all = new Set([...names].map((n) => n.trim()).filter((n) => n && !n.startsWith("@") && !n.startsWith(".")));
	const base = (n: string): string => {
		let b = n;
		while (STYLE.test(b)) b = b.replace(STYLE, "");
		return b;
	};
	return [...all]
		.filter((n) => {
			const b = base(n);
			return b === n || !all.has(b);
		})
		.sort((a, b) => a.localeCompare(b));
}

async function run(cmd: string[]): Promise<string> {
	try {
		const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
		const out = await new Response(p.stdout).text();
		await p.exited;
		return out;
	} catch {
		return "";
	}
}

function macFamilies(): string[] {
	const r = objc();
	if (!r) return [];
	const { send: s, sel } = r;
	const list = s.m0(s.m0(r.cls("NSFontManager"), sel("sharedFontManager")), sel("availableFontFamilies"));
	const n = Number(s.m0(list, sel("count")) ?? 0);
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		const p = s.m0(s.mu(list, sel("objectAtIndex:"), i), sel("UTF8String"));
		if (p) out.push(new CString(p as never).toString());
	}
	return out;
}

async function load(): Promise<string[]> {
	if (process.platform === "win32") {
		const ps =
			"[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";
		return tidy((await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps])).split(/\r?\n/));
	}
	if (process.platform === "darwin") return tidy(macFamilies());
	// fc-list prints "Family[,Localised family]" per font file
	return tidy((await run(["fc-list", ":", "family"])).split(/\r?\n/).map((l) => l.split(",")[0] ?? ""));
}

/** The installed font families, sorted (asked once per run). */
export function installedFonts(): Promise<string[]> {
	return (cached ??= load());
}

/** Families matching `query` (case-insensitive): those starting with it first, then those containing it. */
export function matchFonts(all: readonly string[], query: string, limit = 12): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return all.slice(0, limit);
	const starts = all.filter((f) => f.toLowerCase().startsWith(q));
	const contains = all.filter((f) => !f.toLowerCase().startsWith(q) && f.toLowerCase().includes(q));
	return [...starts, ...contains].slice(0, limit);
}
