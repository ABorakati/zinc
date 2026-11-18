// Quick manual check: bun bench/smoke.ts <plugin dir> [--aot]
import { WtHost, prefsHostModule } from "./lib";
const dir = process.argv[2]!;
const h = new WtHost({
	aot: process.argv.includes("--aot"),
	hostModules: [prefsHostModule],
	onImport: (m) => (console.log("  forwarded import", m.iface, m.fn), undefined),
});
console.log("host up in", (await h.start()).toFixed(1), "ms", h.readyInfo.interfaces);
const l = await h.load(dir);
console.log("load", l);
console.log("startup", JSON.stringify(await h.startup(l.id)));
console.log("on-timer", JSON.stringify(await h.call(l.id, "events", "on-timer", [5, "timeout"])));
console.log("nope", JSON.stringify(await h.call(l.id, "events", "nope", [])));
console.log("logs", h.logs.map((x) => x.message));
console.log("stats", JSON.stringify(await h.stats()));
await h.close();
