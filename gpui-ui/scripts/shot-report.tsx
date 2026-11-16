// Headless screenshot of the "Report a problem" dialog with FAKE log lines (nothing is read from the real log folder):
//   bun scripts/shot-report.tsx [outDir] [light|dark]
// Writes <outDir>/report-dialog.png. Needs no core (the facts say "unknown" where the core is not reachable); the log lines are seeded.
import { createTestRoot } from "@gpuix/solid/testing";
import { mkdirSync } from "node:fs";
import { OverlayHost } from "../src/ui";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";
import { tw } from "../src/theme";
import { openReport } from "../src/features/report/ReportDialog";
import { REPORT_DAYS, type Report } from "../src/features/report/report";
import { formatReport } from "../src/shell/errorlog";

const args = process.argv.slice(2);
const outDir = args.find((a) => /[\\/]/.test(a)) ?? "C:/Users/abora/zn-ws/_tmp/errorlog";
const mode = args.includes("light") ? "light" : "dark";
mkdirSync(outDir, { recursive: true });

const rec = (time: string, level: string, area: string, message: string, stack?: string) =>
	JSON.stringify({
		time,
		level,
		area,
		message,
		...(stack ? { stack } : {}),
		version: "0.9.0-test",
		build: "bytecode",
		os: "Windows_NT 10.0.26300 x64",
	});
const fake = [
	rec("2026-11-05T21:14:02.118Z", "info", "ui", "start"),
	rec("2026-11-05T21:14:09.502Z", "warn", "worker", "[structure] document worker failed: out of memory"),
	rec(
		"2026-11-06T08:02:41.007Z",
		"error",
		"websync",
		"Error: zotero.org answered 503 (backing off 60 s)",
		"Error: zotero.org answered 503\n    at pullOnce (%USERPROFILE%\\zotero-next\\core\\src\\websync\\pull.ts:88:11)",
	),
	rec("2026-11-06T08:03:12.300Z", "error", "core", "GET /api/items/ABCD1234/children: TypeError: undefined is not an object"),
	rec("2026-11-06T09:30:00.000Z", "error", "ui", "error boundary (item pane): Error: render failed"),
	rec("2026-11-06T09:31:10.250Z", "fatal", "ui", "uncaughtException: RangeError: Maximum call stack size exceeded"),
	rec("2026-11-06T09:35:44.911Z", "error", "core", "previous session ended unexpectedly"),
];
const seed: Report = (() => {
	const text = formatReport(
		{
			"App version": "0.9.0-test",
			Build: "bytecode",
			OS: "Windows_NT 10.0.26300 x64",
			Bun: Bun.version,
			"Library items": "6287",
			"Sync mode": "zotero-org, push on, files download",
			"Log folder": "%USERPROFILE%\\AppData\\Roaming\\zotero-next-gpui\\logs",
			"Log range": `last ${REPORT_DAYS} days`,
			Created: "2026-11-06T09:40:00.000Z",
		},
		fake,
		fake.length,
	);
	return { text, rows: text.split("\n"), logLines: fake.length, logTotal: fake.length };
})();

store.setMode(mode);
const t = createTestRoot({ width: 1400, height: 900 });
registerFonts(t.renderer);
const r = t.renderer;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const frames = async (ms: number) => {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		r.flush();
		r.dispatchNativeEvents();
		r.flush();
		await sleep(16);
	}
};

t.render(() => (
	<div style={{ ...tw("flex flex-col bg-canvas", store.mode()), position: "relative", width: "100%", height: "100%" }}>
		<OverlayHost />
	</div>
));
await frames(600);
openReport(seed);
await frames(1200);
const out = `${outDir}/report-dialog${mode === "light" ? "-light" : ""}.png`;
r.captureScreenshot(out);
console.log("wrote", out);
process.exit(0);
