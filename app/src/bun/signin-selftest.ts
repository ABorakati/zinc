// In-app self-test for the embedded sign-in browser. Runs when ZN_SIGNIN_SELFTEST=1 (see index.ts).
// Never types into pages, never signs in, never prints cookie values.
import { Session, Utils } from "electrobun/main";
import { INSTITUTION_PARTITION, type SigninBridge } from "./signin";

const say = (...a: unknown[]) => console.log("[signin-selftest]", ...a);
const hostOf = (u: string) => {
	try {
		return new URL(u).host;
	} catch {
		return "";
	}
};

async function loginCase(b: SigninBridge, label: string, entryUrl: string, realm: string, standby: boolean) {
	const entryHost = hostOf(entryUrl);
	const ac = new AbortController();
	const s = await b.openLogin(
		{ entryUrl, realm, kind: "openathens", waiting: 2, capturePdf: false, ...({ institutionName: label } as object) },
		ac.signal,
	);
	const t0 = Date.now();
	while (Date.now() - t0 < 30_000) {
		await s.waitForChange(500);
		const h = hostOf(s.url());
		if (h && h !== entryHost && Date.now() - t0 > 1500) break;
	}
	await s.waitForChange(2500); // let the login page finish
	const html = await s.html(262144);
	const st = b.debugState();
	say(`(a) ${label}: reached host=${hostOf(s.url())} html=${html.length} chars`);
	say(`(a) ${label}: banner=`, JSON.stringify(st?.banner), `window=${st?.windowId}`, `ua=${st?.ua}`);
	s.setBanner({ status: "waiting for you", challengeHint: true, offerKeepWaiting: true });
	b.simulateBannerAction("skip");
	const actions = s.takeActions();
	say(`(a) ${label}: after Skip press -> takeActions=${JSON.stringify(actions)} closed()=${s.closed()} again=${JSON.stringify(s.takeActions())}`);
	s.finish(standby ? "standby" : "close", 20_000);
	return st?.windowId;
}

export async function runSigninSelftest(b: SigninBridge): Promise<void> {
	let failures = 0;
	const ok = (cond: boolean, msg: string) => {
		say(cond ? "PASS" : "FAIL", msg);
		if (!cond) failures++;
	};
	try {
		// (a) two different institutions, second one reuses the parked window
		const w1 = await loginCase(b, "King's College London", "https://go.openathens.net/redirector/kcl.ac.uk?url=https%3A%2F%2Fwww.nature.com%2F", "kcl", true);
		const w2 = await loginCase(b, "University of Edinburgh", "https://go.openathens.net/redirector/ed.ac.uk?url=https%3A%2F%2Fwww.nature.com%2F", "ed", false);
		ok(w1 !== undefined && w1 === w2, `standby window reused for a second institution (window ${w1} -> ${w2})`);
		await Bun.sleep(500);

		// (b) cookies (names only)
		for (const u of ["https://login.microsoftonline.com/", "https://go.openathens.net/", "https://www.nature.com/"]) {
			const cs = await b.cookiesFor(u);
			say(`(b) cookiesFor ${hostOf(u)}: ${cs.length} cookies`, JSON.stringify(cs.map((c) => `${c.name}@${c.domain}`)).slice(0, 400));
		}

		{
			const sess = Session.fromPartition(INSTITUTION_PARTITION);
			const all = sess.cookies.get();
			const byDomain = sess.cookies.get({ domain: "login.microsoftonline.com" });
			const byUrl = sess.cookies.get({ url: "https://login.microsoftonline.com/" });
			const def = Session.defaultSession.cookies.get();
			const setOk = sess.cookies.set({ name: "zn_probe", value: "1", domain: "example.org", path: "/", secure: true, expirationDate: Math.floor(Date.now() / 1000) + 600 });
			await Bun.sleep(500);
			say(`(b) probe: set=${setOk} getAfterSet=${sess.cookies.get().length} byUrl=${sess.cookies.get({ url: "https://example.org/" }).length}`);
			sess.cookies.remove("https://example.org/", "zn_probe");
			say(`(b) raw Session API: all=${all.length} byDomain=${byDomain.length} byUrl=${byUrl.length} persist:default=${def.length}`, JSON.stringify(all.slice(0, 8).map((c) => `${c.name}@${c.domain}`)));
		}

		// (c) open-access PDF
		for (const u of ["https://europepmc.org/articles/PMC6941396?pdf=render", "https://arxiv.org/pdf/1706.03762"]) {
			const r = await b.load({ url: u, timeoutMs: 45_000, capturePdf: true, userAgent: "plain" }, new AbortController().signal);
			const head = r.pdf ? new TextDecoder("latin1").decode(r.pdf.bytes.subarray(0, 8)) : "";
			say(`(c) ${u} -> final=${r.finalUrl} status=${r.status} trail=${r.urlTrail.length} pdf=${r.pdf ? r.pdf.bytes.length + " bytes, head=" + JSON.stringify(head) + ", filename=" + r.pdf.filename : "none"} ms=${r.ms}`);
			ok(!!r.pdf && head.startsWith("%PDF"), `PDF captured from ${hostOf(u)}`);
			if (r.pdf) break;
		}

		// (d) normal HTML page with a redirect
		const r = await b.load({ url: "https://doi.org/10.1038/s41586-020-2649-2", timeoutMs: 45_000, capturePdf: false }, new AbortController().signal);
		say(`(d) final=${r.finalUrl} status=${r.status} trail=${JSON.stringify(r.urlTrail.map((x) => hostOf(x)))} pageHtml=${r.pageHtml?.length ?? "none"} ms=${r.ms}`);
		ok(!!r.pageHtml && r.pageHtml.length > 1000 && r.urlTrail.length >= 1, "HTML page loaded with pageHtml + urlTrail");
	} catch (e) {
		failures++;
		say("ERROR", e instanceof Error ? e.stack : String(e));
	}
	b.closeAll();
	say(failures ? `DONE with ${failures} failure(s)` : "DONE all passed");
	await Bun.sleep(300);
	Utils.quit(failures ? 1 : 0);
}
