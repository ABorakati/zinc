// Copies what the site shows from outside website/ into public/ (run by the docs:* scripts before dev and build).
//   docs/screenshots/**  -> public/screenshots/**   (generated copy, git-ignored)
//   the app icon         -> public/icon.svg, icon.png (gpui-ui/assets, else app/assets)
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "..");

const shots = join(repo, "docs", "screenshots");
const out = join(site, "public", "screenshots");
rmSync(out, { recursive: true, force: true });
if (existsSync(shots)) cpSync(shots, out, { recursive: true });
else mkdirSync(out, { recursive: true });

for (const dir of [join(repo, "gpui-ui", "assets"), join(repo, "app", "assets")]) {
	let copied = false;
	for (const f of ["icon.svg", "icon.png"]) {
		if (existsSync(join(dir, f))) { cpSync(join(dir, f), join(site, "public", f)); copied = true; }
	}
	if (copied) break;
}
console.log("[docs] assets synced");
