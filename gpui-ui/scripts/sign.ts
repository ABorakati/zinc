// Code signing hook. Does nothing until a certificate is configured.
//
//   bun scripts/sign.ts <file>...        sign the files in place (what the installer compiler's SignTool hook runs)
//   bun scripts/sign.ts --check <file>   print whether the files carry a signature (signtool verify /pa; an untrusted self-signed
//                                        certificate still counts as "signed")
//   import { signFiles } from "./sign"   package.ts and installer.ts call this
//
// Configuration (environment). The first complete set wins:
//   ZN_SIGN_PFX + ZN_SIGN_PFX_PASSWORD                               a code-signing certificate in a .pfx file, signed with signtool
//   ZN_SIGN_AZURE_ENDPOINT + ZN_SIGN_AZURE_ACCOUNT + ZN_SIGN_AZURE_PROFILE
//                                                                    Azure Artifact Signing (formerly Trusted Signing), signed with
//                                                                    Microsoft's `sign` tool; credentials come from the Azure CLI login /
//                                                                    managed identity (ZN_SIGN_AZURE_CREDENTIAL = azure-cli | azure-powershell
//                                                                    | managed-identity | workload-identity, default: DefaultAzureCredential)
// Optional:
//   ZN_SIGN_TIMESTAMP   RFC 3161 timestamp server (default http://timestamp.acs.microsoft.com for Azure, http://timestamp.digicert.com
//                       for a pfx). "none" signs without a timestamp (the signature then dies with the certificate).
//   ZN_SIGN_TOOL        path of signtool.exe (pfx) or of `sign` (Azure). Default: newest signtool under C:\Program Files (x86)\Windows Kits\10\bin\*\x64,
//                       and `sign` from PATH (dotnet tool install --global sign --prerelease).
//   ZN_SIGN_DESCRIPTION text shown by UAC / SmartScreen (default "Zotero Next")
// With nothing configured it prints "unsigned: no certificate configured" and returns. A configured but failing signature is an error
// (never a silently unsigned release). The certificate and its password are never written anywhere by this script and are not
// imported into any Windows certificate store: signtool reads the .pfx directly.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type SignConfig =
	| { kind: "pfx"; pfx: string; password: string }
	| { kind: "azure"; endpoint: string; account: string; profile: string }
	| null;

export function signConfig(env: Record<string, string | undefined> = process.env): SignConfig {
	if (env.ZN_SIGN_PFX && env.ZN_SIGN_PFX_PASSWORD !== undefined) return { kind: "pfx", pfx: env.ZN_SIGN_PFX, password: env.ZN_SIGN_PFX_PASSWORD };
	if (env.ZN_SIGN_PFX) throw new Error("ZN_SIGN_PFX is set but ZN_SIGN_PFX_PASSWORD is not (use an empty value for a passwordless pfx)");
	if (env.ZN_SIGN_AZURE_ENDPOINT || env.ZN_SIGN_AZURE_ACCOUNT || env.ZN_SIGN_AZURE_PROFILE) {
		const { ZN_SIGN_AZURE_ENDPOINT: endpoint, ZN_SIGN_AZURE_ACCOUNT: account, ZN_SIGN_AZURE_PROFILE: profile } = env;
		if (!endpoint || !account || !profile) throw new Error("Azure signing needs all of ZN_SIGN_AZURE_ENDPOINT, ZN_SIGN_AZURE_ACCOUNT and ZN_SIGN_AZURE_PROFILE");
		return { kind: "azure", endpoint, account, profile };
	}
	return null;
}

/** The newest signtool.exe of the Windows SDK (x64), or null. */
export function findSigntool(env: Record<string, string | undefined> = process.env): string | null {
	if (env.ZN_SIGN_TOOL) return env.ZN_SIGN_TOOL;
	const bin = join(env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Windows Kits", "10", "bin");
	if (!existsSync(bin)) return null;
	const vers = readdirSync(bin).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort((a, b) => cmpVer(b, a));
	for (const v of vers) {
		const p = join(bin, v, "x64", "signtool.exe");
		if (existsSync(p)) return p;
	}
	return null;
}
const cmpVer = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (x[i]! - y[i]!); return 0; };

function run(cmd: string[], redact: string[] = []): { code: number; out: string } {
	const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	let out = `${r.stdout.toString()}${r.stderr.toString()}`;
	for (const s of redact) if (s) out = out.split(s).join("***");
	return { code: r.exitCode ?? 1, out: out.trim() };
}

/** Signs `files` in place. Returns true when they were signed, false when no certificate is configured (nothing is touched then). */
export function signFiles(files: string[], env: Record<string, string | undefined> = process.env): boolean {
	const cfg = signConfig(env);
	if (!cfg) { console.log("unsigned: no certificate configured"); return false; }
	const existing = files.filter((f) => existsSync(f));
	if (existing.length !== files.length) throw new Error(`sign: missing ${files.filter((f) => !existsSync(f)).join(", ")}`);
	if (!files.length) return true;
	const desc = env.ZN_SIGN_DESCRIPTION || "Zotero Next";
	const tsRaw = env.ZN_SIGN_TIMESTAMP;
	if (cfg.kind === "pfx") {
		const tool = findSigntool(env);
		if (!tool) throw new Error("signtool.exe not found: install the Windows SDK (Signing Tools) or set ZN_SIGN_TOOL");
		const ts = tsRaw === "none" ? [] : ["/tr", tsRaw || "http://timestamp.digicert.com", "/td", "sha256"];
		const base = [tool, "sign", "/fd", "sha256", ...ts, "/d", desc, "/f", cfg.pfx, ...(cfg.password ? ["/p", cfg.password] : [])];
		for (const f of files) {
			const r = run([...base, f], [cfg.password]);
			if (r.code !== 0) throw new Error(`signtool failed for ${f} (exit ${r.code}):\n${r.out}`);
		}
	} else {
		const tool = env.ZN_SIGN_TOOL || Bun.which("sign");
		if (!tool) throw new Error("the `sign` tool is not installed: dotnet tool install --global sign --prerelease (or set ZN_SIGN_TOOL)");
		const cred = env.ZN_SIGN_AZURE_CREDENTIAL ? ["-act", env.ZN_SIGN_AZURE_CREDENTIAL] : [];
		const ts = tsRaw === "none" ? [] : ["-t", tsRaw || "http://timestamp.acs.microsoft.com/"];
		const r = run([tool, "code", "artifact-signing", "-ase", cfg.endpoint, "-asa", cfg.account, "-ascp", cfg.profile, ...cred, ...ts, "-d", desc, ...files]);
		if (r.code !== 0) throw new Error(`sign failed (exit ${r.code}):\n${r.out}`);
	}
	console.log(`signed (${cfg.kind}): ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
	return true;
}

/** `signtool verify /pa`. present = the file has an Authenticode signature (even when its certificate chain is untrusted). */
export function verifySignature(file: string, env: Record<string, string | undefined> = process.env): { present: boolean; trusted: boolean; output: string } {
	const tool = findSigntool(env);
	if (!tool) throw new Error("signtool.exe not found");
	if (!existsSync(file)) return { present: false, trusted: false, output: "file not found" };
	const r = run([tool, "verify", "/pa", file]);
	const trusted = r.code === 0;
	// exit 1 with "No signature found" (or any other failure) = unsigned; exit 1 with a chain message = signed by a certificate this machine does not trust
	const present = trusted || /certificate chain processed|Signing Certificate Chain|not trusted by the trust provider/i.test(r.out);
	return { present, trusted, output: r.out };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === "--check") {
		let bad = 0;
		for (const f of args.slice(1)) {
			const v = verifySignature(f);
			console.log(`${f}: signature ${v.present ? "present" : "ABSENT"}${v.present ? (v.trusted ? ", trusted" : ", not trusted by this machine") : ""}`);
			if (!v.present) bad++;
		}
		process.exit(bad ? 1 : 0);
	}
	if (!args.length) { console.error("usage: bun scripts/sign.ts <file>...   |   --check <file>..."); process.exit(2); }
	try { signFiles(args); } catch (e) { console.error(String((e as Error).message ?? e)); process.exit(1); }
}
