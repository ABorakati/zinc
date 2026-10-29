// Injected into the reader page by the spike server. Checks PDF rendering and
// Reading Mode, then POSTs a report to /spike/report.
(() => {
	const errors = [];
	addEventListener('error', e => errors.push(String(e.message)));
	addEventListener('unhandledrejection', e => errors.push('rejection: ' + String(e.reason?.message ?? e.reason)));
	const consoleError = console.error;
	console.error = (...args) => {
		errors.push(args.map(String).join(' ').slice(0, 300));
		consoleError(...args);
	};

	const sleep = ms => new Promise(r => setTimeout(r, ms));
	async function waitFor(fn, ms) {
		const start = Date.now();
		while (Date.now() - start < ms) {
			try {
				const v = fn();
				if (v) return v;
			}
			catch {}
			await sleep(250);
		}
		return null;
	}

	(async () => {
		const report = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, errors };
		const t0 = performance.now();
		const reader = await waitFor(() => window._reader, 20000);
		report.readerCreated = !!reader;
		if (reader) {
			// Don't await reader.initializedPromise: it never resolves (Zotero forum
			// thread 132924); poll for rendered page canvases instead.
			const doc = () => reader._primaryView?._iframe?.contentDocument;
			report.pagesRendered = await waitFor(() => doc()?.querySelectorAll('.page canvas').length, 20000) || 0;
			report.firstRenderMs = Math.round(performance.now() - t0);
			report.textLayerChars = (doc()?.querySelector('.textLayer')?.textContent ?? '').length;
			report.outlineItems = reader._state?.outline?.length ?? null;

			const t1 = performance.now();
			try {
				await Promise.race([
					reader._setReadingMode(true, true),
					sleep(90000).then(() => { throw new Error('Reading Mode timed out'); }),
				]);
				const sdtDoc = () => reader._primarySDTView?._iframe?.contentDocument;
				const text = await waitFor(() => {
					const t = sdtDoc()?.body?.innerText;
					return t && t.length > 200 ? t : null;
				}, 20000);
				report.readingModeMs = Math.round(performance.now() - t1);
				report.readingModeChars = text?.length ?? 0;
				report.readingModeSample = text?.slice(0, 300) ?? null;
			}
			catch (e) {
				report.readingModeError = String(e?.message ?? e);
			}
		}
		await fetch('/spike/report', { method: 'POST', body: JSON.stringify(report) });
	})();
})();
