// Regenerate app/assets/icon.ico from app/assets/icon.svg with every size Windows asks for (title bar, taskbar and Explorer at
// 100-300 % scaling: 16, 20, 24, 32, 40, 48, 64, 96, 128, 256 px), each rendered from the vector, PNG-encoded inside the .ico.
// The renderer is not a dependency of the repo; run from a scratch folder that has it:
//   mkdir icon-tmp && cd icon-tmp && bun add @resvg/resvg-js@2.6.2 && bun <repo>/app/scripts/make-icon.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { Resvg } = (await import(join(process.cwd(), "node_modules", "@resvg", "resvg-js", "index.js"))) as typeof import("@resvg/resvg-js");
const assets = join(import.meta.dir, "..", "assets");
const svg = readFileSync(join(assets, "icon.svg"), "utf8");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const pngs = SIZES.map((s) => new Resvg(svg, { fitTo: { mode: "width", value: s }, shapeRendering: 2 }).render().asPng());

// ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, then the PNG data
const head = Buffer.alloc(6 + 16 * SIZES.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2); // 1 = icon
head.writeUInt16LE(SIZES.length, 4);
let offset = head.length;
SIZES.forEach((s, i) => {
	const e = 6 + 16 * i;
	head[e] = s >= 256 ? 0 : s; // 0 means 256
	head[e + 1] = s >= 256 ? 0 : s;
	head[e + 2] = 0; // palette
	head[e + 3] = 0;
	head.writeUInt16LE(1, e + 4); // planes
	head.writeUInt16LE(32, e + 6); // bits per pixel
	head.writeUInt32LE(pngs[i]!.length, e + 8);
	head.writeUInt32LE(offset, e + 12);
	offset += pngs[i]!.length;
});
writeFileSync(join(assets, "icon.ico"), Buffer.concat([head, ...pngs.map((p) => Buffer.from(p))]));
for (const s of [16, 32, 48]) writeFileSync(join(assets, `icon-${s}.png`), pngs[SIZES.indexOf(s)]!);
writeFileSync(join(assets, "icon.png"), pngs[SIZES.indexOf(256)]!);
console.log(`icon.ico: ${SIZES.join(", ")} px (${(offset / 1024).toFixed(0)} KB)`);
