// The script that draws the sign-in bar at the bottom of the page in the sign-in window ("Signing in to <institution> for N items",
// Keep waiting / Open in browser / Skip). It runs in an ISOLATED WORLD of the page (Page.addScriptToEvaluateOnNewDocument with a
// worldName): the page's own scripts cannot read or call anything it defines, and the buttons reach the helper through a Runtime binding
// that exists only in that world. The bar lives in a closed shadow root in the top layer (popover), styled with a constructable
// stylesheet and built with DOM calls only, so a strict page CSP or Trusted Types cannot block it. It shows no URL: the window title,
// set by the app from the browser's own navigation events, tells where the user is typing.
export const OVERLAY_WORLD = "zn-signin";
export const OVERLAY_BINDING = "znSend";

export const OVERLAY_SOURCE = `(() => {
	if (window.top !== window || globalThis.__znBarInstalled) return;
	globalThis.__znBarInstalled = true;
	let state = null, host = null, parts = null;
	const css = new CSSStyleSheet();
	css.replaceSync(
		":host{all:initial}" +
		".bar{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:6px 12px;background:#1b1f29;color:#e8ebf2;font:13px system-ui,Segoe UI,sans-serif;border-top:1px solid #394055}" +
		".msg{flex:1 1 240px;min-width:0}" +
		".hint{flex:1 0 100%;order:2;box-sizing:border-box;background:rgba(220,160,0,.25);padding:2px 8px;border-radius:4px}" +
		"button{font:inherit;padding:3px 10px;border:1px solid #5b6475;background:#262c3a;color:#e8ebf2;border-radius:5px;cursor:pointer}" +
		"button:hover{border-color:#e8ebf2}[hidden]{display:none!important}"
	);
	function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
	function send(a) { try { globalThis.znSend(JSON.stringify({ a })); } catch (e) {} }
	function build() {
		const root = document.documentElement;
		if (!root) return false;
		host = document.createElement("zn-signin-bar");
		const shadow = host.attachShadow({ mode: "closed" });
		shadow.adoptedStyleSheets = [css];
		const bar = el("div", "bar");
		const msg = el("span", "msg");
		const hint = el("span", "hint", "This page may need a human check (captcha or multi-factor prompt). Complete it in this window.");
		const mk = (label, a) => { const b = el("button", "", label); b.addEventListener("click", (ev) => { if (ev.isTrusted) send(a); }); return b; };
		const keep = mk("Keep waiting", "keep_waiting"), handoff = mk("Open in browser", "handoff"), skip = mk("Skip", "skip");
		bar.append(msg, hint, keep, handoff, skip);
		shadow.append(bar);
		parts = { msg, hint, keep, handoff, skip };
		host.style.cssText = "position:fixed;left:0;right:0;bottom:0;width:100%;margin:0;padding:0;border:0;background:transparent;overflow:visible;inset:auto 0 0 0;height:auto";
		host.setAttribute("popover", "manual");
		root.append(host);
		try { host.showPopover(); } catch (e) {}
		return true;
	}
	function draw() {
		if (!state) { if (host) host.remove(); host = null; return; }
		if (!host || !host.isConnected) { if (!build()) return; }
		const n = state.waiting | 0;
		parts.msg.textContent = state.standby
			? "Checking access..."
			: "Signing in to " + state.institution + (n > 0 ? " for " + n + (n === 1 ? " item" : " items") : "") + (state.status ? " - " + state.status : "");
		parts.keep.hidden = !state.offerKeepWaiting || state.standby;
		parts.hint.hidden = !state.challengeHint || state.standby;
		parts.handoff.hidden = state.standby;
		parts.skip.hidden = state.standby;
	}
	globalThis.__znRender = (s) => { state = s; draw(); };
	document.addEventListener("DOMContentLoaded", draw);
	send("ready");
})();`;
