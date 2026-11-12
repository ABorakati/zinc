// Which build of Zinc a feed entry is for, and where each platform finds its entry. Pure: no I/O.
//
//   win-x64        latest.json               the Inno Setup installer (Zinc-Setup-*.exe), run silently (updater.ts, env.runInstaller)
//   linux-x64      latest-linux-x64.json     the AppImage; the running $APPIMAGE file is replaced (replace.ts)
//   darwin-arm64   latest-darwin-arm64.json  Zinc.app as a zip (ditto -c -k --keepParent); the bundle is swapped by a helper script (replace.ts)
//
// The Windows file keeps its name and has no "platform" field, so Windows builds from before this change still read it. The others carry
// a signed "platform" and the updater refuses an entry for another platform, so a feed host cannot hand a Linux client the Windows exe.

export type UpdatePlatform = "win-x64" | "linux-x64" | "darwin-arm64" | "darwin-x64";

/** The platform of this process, or null for one that has no builds (32-bit, FreeBSD...). */
export function currentPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): UpdatePlatform | null {
	if (platform === "win32" && arch === "x64") return "win-x64";
	if (platform === "linux" && arch === "x64") return "linux-x64";
	if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
	if (platform === "darwin" && arch === "x64") return "darwin-x64";
	return null;
}

/** The platform a manifest is for: its "platform" field, else "win-x64" (latest.json has none). */
export const manifestPlatform = (m: { platform?: string }): string => m.platform ?? "win-x64";

/** File name of a platform's manifest. */
export const feedFileName = (p: UpdatePlatform): string => (p === "win-x64" ? "latest.json" : `latest-${p}.json`);

/**
 * The manifest URL a platform reads, from the configured feed URL (which names latest.json). On Windows: the URL itself. Elsewhere: a URL
 * whose path ends in /latest.json gets latest-<platform>.json in its place (query and fragment kept); any other URL is used as it is (a
 * feed set by hand straight to latest-linux-x64.json, or an API URL for one asset).
 */
export function feedUrlFor(url: string, p: UpdatePlatform): string {
	if (p === "win-x64") return url;
	let u: URL;
	try { u = new URL(url); } catch { return url; }
	if (!/(^|\/)latest\.json$/.test(u.pathname)) return url;
	u.pathname = u.pathname.replace(/latest\.json$/, feedFileName(p));
	return u.toString();
}
