// The Bun canary that builds the aot variant (stable Bun 1.4.4 has no AOT compiler; compile.aot exists only in canary builds).
//
//   bun scripts/_bun-canary.ts      # prints the path of the canary bun for this OS and CPU, downloading it first if needed
//
// Where it comes from, first match wins:
//   1. ZN_BUN_CANARY: a canary bun(.exe) you already have. Used as is.
//   2. Windows: the canary the Windows release has always been built with (1.4.5-canary.1+5f3f8fe48), if it is on this machine.
//   3. Otherwise the pinned daily canary from npm, @oven/bun-<os>-<arch>@1.4.4-canary.20261116.1 (it reports itself as
//      1.4.5-canary.1+237bba51e: the Windows canary's commit plus one AOT fix, oven-sh/bun#49081). npm keeps every daily canary, unlike
//      GitHub's rolling `canary` tag, so this version can be pinned. It is downloaded once into out/tools/bun-<version>-<os>-<arch>/ and
//      checked against the sha512 below (npm's dist.integrity). ZN_BUN_CANARY_DIR moves that folder.
// The global bun is never touched.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const CANARY_VERSION = "1.4.4-canary.20261116.1";
const WINDOWS_LOCAL = "C:/Users/abora/zn-ws/_tmp/bun-aot/canary-2026-11-16/bun-windows-x64/bun.exe";

/** npm package per `${process.platform}-${process.arch}`, with its sha512 (base64, npm's dist.integrity) for CANARY_VERSION. */
const PACKAGES: Record<string, { name: string; sha512: string }> = {
	"linux-x64": {
		name: "bun-linux-x64",
		sha512: "CNCvfrDyCZVG+Ac36r3w6Mn2O/9olJ22DcCT5CCUytfNDtvqwo6RkpJohMTUuJAK9T8rwJK0ns3+XCymLVr65g==",
	},
	"linux-arm64": {
		name: "bun-linux-aarch64",
		sha512: "08ipq9f+z3Xeku5tV49E5/ZwaXuWxdv9VJUEqL+DcBzgHYEEtSaoVgEKsCHeWWWCy76Jg0rkeR3C2vnRUN5XMA==",
	},
	"darwin-arm64": {
		name: "bun-darwin-aarch64",
		sha512: "7nZQYPOEMC2dzdc71G3HaWJJ5h8YIM7rRyxYwgyRYWKazmzDktLVcAVeGdXuJ1mpp9WdWCYKuBVotpSwDDf5OA==",
	},
	"darwin-x64": {
		name: "bun-darwin-x64",
		sha512: "QnzRXt4kxsF1JnOYphsyYwIHk3B+zJOaPgzn4ZVm01hJW8QJ7upD0SWl2O8A9F4RmcG4XeC7Gus8I/lIBuAbAQ==",
	},
	"win32-x64": {
		name: "bun-windows-x64",
		sha512: "dAV4bvPzbFKkxdpi2OyYQmM3aWG/IMogcMiG1pWc/VtI8sfIna/GfOFTNdZPqS0HwGWtlBwLMZpYC4XkZW6yIA==",
	},
};

/** The canary bun for this machine: ZN_BUN_CANARY, the local Windows canary, or the pinned npm canary (downloaded once). */
export async function canaryBun(): Promise<string> {
	if (process.env.ZN_BUN_CANARY) return process.env.ZN_BUN_CANARY;
	if (process.platform === "win32" && existsSync(WINDOWS_LOCAL)) return WINDOWS_LOCAL;
	const key = `${process.platform}-${process.arch}`;
	const pkg = PACKAGES[key];
	if (!pkg) throw new Error(`no pinned Bun canary for ${key}; set ZN_BUN_CANARY to a canary bun with compile.aot`);
	const exe = process.platform === "win32" ? "bun.exe" : "bun";
	const dir = resolve(process.env.ZN_BUN_CANARY_DIR ?? join(import.meta.dir, "..", "out", "tools"), `bun-${CANARY_VERSION}-${key}`);
	const bin = join(dir, exe);
	if (existsSync(bin)) return bin;

	const url = `https://registry.npmjs.org/@oven/${pkg.name}/-/${pkg.name}-${CANARY_VERSION}.tgz`;
	console.log(`[aot] downloading the Bun canary: ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Bun canary download failed: HTTP ${res.status} ${url}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const sum = createHash("sha512").update(bytes).digest("base64");
	if (sum !== pkg.sha512) throw new Error(`Bun canary sha512 mismatch for ${url}`);
	// unpack with the system tar (Linux, macOS, and Windows 10+ ship one) into a scratch folder, then move bin/bun into place
	const tmp = `${dir}.part`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	writeFileSync(join(tmp, "bun.tgz"), bytes);
	const tar = Bun.spawnSync(["tar", "-xzf", "bun.tgz"], { cwd: tmp, stdout: "inherit", stderr: "inherit" });
	if (tar.exitCode !== 0) throw new Error(`tar -xzf failed (${tar.exitCode}) on ${url}`);
	mkdirSync(dirname(bin), { recursive: true });
	renameSync(join(tmp, "package", "bin", exe), bin);
	rmSync(tmp, { recursive: true, force: true });
	if (process.platform !== "win32") chmodSync(bin, 0o755);
	return bin;
}

if (import.meta.main) console.log(await canaryBun());
