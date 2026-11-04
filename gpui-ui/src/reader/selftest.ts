// Self-test of the reader's academic mentions in a REAL window (the packaged exe), driven through GPUIX's own input simulation (the live
// renderer's simulateMouseMove: no OS mouse or keyboard, no other windows). Enabled by ZN_READER_SELFTEST=<output dir> together with
// ZN_OPEN_TABS=<attachment key> (main.tsx opens the PDF); the first reader that opens runs it once and then ends the process.
//   selftest.json   what happened: the structure worker (phase, time, counts, error), the mentions found, the hover result
//   selftest-*.png  window screenshots (captureScreenshot of the live renderer)
// ZN_READER_SELFTEST_PAGE (0-based, default 0) is the page to hover on.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { academicFor } from "./academic/session";
import type { ReaderContext } from "./plugins";
import { toNRect } from "./structure/pagetext";

interface LiveRenderer {
	/** the real window's renderer; the headless test renderer calls it nativeSimulateMouseMove (and needs dispatchNativeEvents, which the script pumps) */
	simulateMouseMove?(x: number, y: number, pressedButton?: number, modifiers?: string): void;
	nativeSimulateMouseMove?(x: number, y: number): void;
	captureScreenshot?(path: string): void;
	getElementBounds?(id: number): { x: number; y: number; width: number; height: number } | null;
}

let started = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function selfTestDir(): string | undefined { return process.env.ZN_READER_SELFTEST || undefined; }

export async function runSelfTest(ctx: ReaderContext, renderer: LiveRenderer): Promise<void> {
	const dir = selfTestDir();
	if (!dir || started) return;
	started = true;
	mkdirSync(dir, { recursive: true });
	const t0 = performance.now();
	const log: Record<string, unknown> = {
		exe: process.execPath, docworkerEntry: process.env.ZN_DOCWORKER_ENTRY ?? null, root: process.env.ZN_ROOT ?? null, attachment: ctx.attachmentKey, pages: ctx.pageCount(),
	};
	const write = () => writeFileSync(join(dir, "selftest.json"), JSON.stringify(log, null, 1));
	const shot = async (name: string) => {
		try { renderer.captureScreenshot?.(join(dir, `selftest-${name}.png`)); log[`shot:${name}`] = renderer.captureScreenshot ? "ok" : "no captureScreenshot on the live renderer"; } catch (e) { log[`shot:${name}`] = `failed: ${(e as Error).message}`; }
		await sleep(150);
	};
	const page = Number(process.env.ZN_READER_SELFTEST_PAGE ?? 0);
	const move = (x: number, y: number) => (renderer.simulateMouseMove ?? renderer.nativeSimulateMouseMove)!.call(renderer, x, y);
	try {
		const ac = academicFor(ctx);
		ctx.scrollTo(page, 0);
		await sleep(2500);
		// the mention before / without the structure: from the page text and the PDF's links
		const pt = await ac.pageText(page);
		log.pageTextChars = pt.text.length;
		const m = /\[\d+(?:[,–-]\s*\d+)*\]/.exec(pt.text) ?? /\b(?:Figure|Fig\.|Table)\s+\d+/.exec(pt.text);
		log.mention = m?.[0] ?? null;
		log.structureAtHover = ac.struct().phase;
		if (m) {
			const sz = ctx.pageSize(page);
			const rs = pt.rects.slice(m.index, m.index + m[0].length);
			const nr = toNRect([Math.min(...rs.map((q) => q[0])), Math.min(...rs.map((q) => q[1])), Math.max(...rs.map((q) => q[2])), Math.max(...rs.map((q) => q[3]))], sz.w, sz.h);
			const w = ctx.rectToWindow?.(page, nr);
			log.window = w ?? null;
			await shot("before-hover");
			if (w) {
				const x = w.x + w.width / 2, y = w.y + w.height / 2;
				move(x - 40, y + 40);
				await sleep(150);
				move(x, y);
				const t1 = performance.now();
				let ms = -1;
				for (let i = 0; i < 40; i++) { await sleep(100); if (ac.popup()) { ms = Math.round(performance.now() - t1); break; } }
				log.hover = { x, y, popup: ac.popup()?.key ?? null, msToOpen: ms };
				await sleep(600);
				await shot("hover");
				move(x + 500, y + 300);
				await sleep(1500);
				log.afterLeave = ac.popup()?.key ?? null;
			}
		}
		// the structure worker: does it run through the in-process core in this build?
		const t2 = performance.now();
		for (let i = 0; i < 600 && ac.struct().phase === "loading"; i++) await sleep(200);
		const st = ac.struct();
		log.structure = { phase: st.phase, error: st.phase === "error" ? st.message : undefined, waitedMs: Math.round(performance.now() - t2) };
		if (st.phase === "ready") log.structure = { ...(log.structure as object), blocks: st.doc.blocks.length, figures: st.doc.figures.length, tables: st.doc.tables.length, references: st.doc.references.length };
		await sleep(3000);
		log.figItems = ac.figItems().length;
		log.analysed = ac.analysed();
		await shot("after-structure");
	} catch (e) {
		log.error = (e as Error).stack ?? String(e);
	}
	log.totalMs = Math.round(performance.now() - t0);
	write();
	setTimeout(() => process.exit(0), 300);
}
