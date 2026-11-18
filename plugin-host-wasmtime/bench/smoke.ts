// Quick manual check: bun bench/smoke.ts <plugin dir> [--nobridge] [--aot]
import { WtHost } from "./lib";
const dir = process.argv[2]!;
const h = new WtHost({ bridge: !process.argv.includes("--nobridge"), aot: process.argv.includes("--aot"), hostModules: [(await import("./lib")).prefsHostModule], onImport: (m) => (console.log("  forwarded import", m.iface, m.fn), undefined) });
console.log("host up in", (await h.start()).toFixed(0), "ms", h.readyInfo.interfaces);
const l = await h.load(dir);
console.log("load", l);
console.log("startup", JSON.stringify(await h.startup(l.id)));
console.log("on-timer", JSON.stringify(await h.call(l.id, "events", "on-timer", [5, "timeout"])));
console.log("nope", JSON.stringify(await h.call(l.id, "events", "nope", [])));
console.log("logs", h.logs.map((x) => x.message));
console.log("stats", JSON.stringify(await h.stats()));
await h.close();
