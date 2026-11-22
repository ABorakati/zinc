// Pure builders for the `web-view` sandbox (no Solid, no WebView): the TOP page of a plugin web view is always the host-built wrapper
// from buildWrapper(); plugin content only ever lives in the one sandboxed iframe inside it (srcdoc for html / asset sources, src for
// url sources). The iframe has an opaque origin (never allow-same-origin), so it cannot reach the shared WebView2 profile's cookies or
// storage; the wrapper's content security policy lists the only origins a frame may load or be navigated or redirected to (frame-src),
// which is what stops meta refresh, location=, redirects and nested frames from leaving the allow-list. special.tsx wires these up.

/** Host names that mean "this machine or this network": never allowed, whatever the plugin asks for. */
const DENIED_TLDS = new Set(["localhost", "local", "internal", "lan", "home", "corp", "intranet", "private", "localdomain", "arpa", "onion", "invalid", "test", "example"]);
/** Public DNS services that resolve any name to the address written in it (including 127.0.0.1): a wildcard there reaches loopback. */
const DENIED_DOMAINS = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "traefik.me", "localhost.run", "vcap.me"];
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^(\\*\\.)?(${LABEL}(?:\\.${LABEL})+)(?::(\\d{1,5}))?$`);

export interface HostParts {
	wild: boolean;
	/** host without the "*." of a wildcard */
	host: string;
	/** "" for the default port (443) */
	port: string;
}

/** Parse "[https://][*.]host[:port]" into parts, or null when it is not a plain public https origin. Never throws. */
export function parseHost(raw: unknown): HostParts | null {
	if (typeof raw !== "string" || raw.length > 270) return null;
	let s = raw.trim().toLowerCase();
	if (s.startsWith("https://")) s = s.slice(8);
	const m = HOST_RE.exec(s);
	if (!m) return null;
	const host = m[2]!;
	if (host.length > 253) return null;
	const labels = host.split(".");
	const tld = labels[labels.length - 1]!;
	// a numeric last label is an IP address or an IP-ish spelling (127.1, 0x7f.0.0.1, 10.1.2): a real top-level domain starts with a letter
	if (!/^[a-z]/.test(tld) || DENIED_TLDS.has(tld)) return null;
	if (labels.some((l) => l.startsWith("xn--") && l.length < 5)) return null;
	for (const d of DENIED_DOMAINS) if (host === d || host.endsWith(`.${d}`)) return null;
	if (m[1] && labels.length < 2) return null;
	let port = m[3] ?? "";
	if (port) {
		const n = Number(port);
		if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
		port = n === 443 ? "" : String(n);
	}
	return { wild: !!m[1], host, port };
}

/** The canonical CSP source expression for a host spec ("https://*.example.com:8443"), or null. */
export function normaliseHost(raw: unknown): string | null {
	const p = parseHost(raw);
	return p ? `https://${p.wild ? "*." : ""}${p.host}${p.port ? `:${p.port}` : ""}` : null;
}

/** The origins a web view may talk to: what the plugin asked for (`allow-hosts`) that its manifest `net` grant also lists, normalised. */
export function allowedOrigins(requested: unknown, granted: unknown): string[] {
	const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(normaliseHost).filter((x): x is string => x !== null) : []);
	const g = new Set(list(granted));
	return [...new Set(list(requested).filter((o) => g.has(o)))];
}

/** `raw` as a normalised https URL when its origin is covered by `origins` (output of allowedOrigins), else null. */
export function allowedUrl(raw: unknown, origins: string[]): string | null {
	if (typeof raw !== "string") return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" || u.username || u.password) return null;
	const own = parseHost(u.hostname + (u.port ? `:${u.port}` : ""));
	if (!own || own.wild) return null;
	const covered = origins.some((o) => {
		const p = parseHost(o);
		if (!p || p.port !== own.port) return false;
		return p.wild ? own.host.endsWith(`.${p.host}`) : own.host === p.host;
	});
	return covered ? u.href : null;
}

/** Text for an HTML attribute value in double quotes. */
export function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n\t\0]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The wrapper's content security policy. Everything is denied except what a srcdoc child (which inherits this policy) needs, scoped to
 * `origins`; frame-src lists only those origins, which also blocks any navigation or redirect of the frame elsewhere. A url source
 * gets only what the wrapper itself needs: the remote page has its own policy and is not affected by this one.
 */
export function wrapperCsp(kind: "srcdoc" | "url", scripts: boolean, origins: string[]): string {
	const net = origins.join(" ");
	const frame = `frame-src ${net || "'none'"}`;
	if (kind === "url") return `default-src 'none'; style-src 'unsafe-inline'; ${frame}; form-action 'none'; base-uri 'none'`;
	return [
		"default-src 'none'",
		`img-src data: blob: ${net}`.trim(),
		`style-src 'unsafe-inline' ${net}`.trim(),
		`font-src data: ${net}`.trim(),
		...(scripts ? [`script-src 'unsafe-inline' ${net}`.trim()] : []),
		`connect-src ${net || "'none'"}`,
		frame,
		"form-action 'none'",
		"base-uri 'none'",
	].join("; ");
}

export const FRAME_ID = "zn-frame";

export interface WrapperOpts {
	/** srcdoc: `value` is the plugin's HTML; url: `value` is an https URL already checked with allowedUrl() */
	kind: "srcdoc" | "url";
	value: string;
	scripts: boolean;
	origins: string[];
}

/** The trusted top-level document: one sandboxed iframe, nothing else. */
export function buildWrapper(o: WrapperOpts): string {
	// the sandbox never gains allow-same-origin (opaque origin), allow-top-navigation*, allow-popups*, allow-forms, allow-modals or allow-downloads
	const sandbox = o.scripts ? "allow-scripts" : "";
	const content = o.kind === "url" ? `src="${escapeAttr(o.value)}"` : `srcdoc="${escapeAttr(o.value)}"`;
	return (
		`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(wrapperCsp(o.kind, o.scripts, o.origins))}">` +
		`<title></title><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;display:block;width:100%;height:100%}</style>` +
		`<iframe id="${FRAME_ID}" sandbox="${sandbox}" referrerpolicy="no-referrer" allow="" ${content}></iframe>`
	);
}

export function wrapperUrl(o: WrapperOpts): string {
	return "data:text/html;charset=utf-8," + encodeURIComponent(buildWrapper(o));
}

/**
 * Script the host registers to run before the scripts of every document and frame of the view (webview_init). `nonce` is a secret of
 * this view's host and wrapper: a frame cannot read it, so a message that reaches the host binding without it is dropped.
 *   top document (the wrapper): relays frame -> plugin messages, only from the iframe's own window, through window.znMsg
 *   frame directly under it: defines window.zinc.postMessage / onmessage on top of window.postMessage to its parent
 *   any other frame: loses the host binding and the raw WebView bridge
 */
export function sandboxInit(messaging: boolean, nonce: string): string {
	return `(function(){
var MSG=${messaging ? "true" : "false"},N=${JSON.stringify(nonce)},W=window,P=W.parent,TOP=W.top===W;
var send=W.znMsg,wv=null;try{wv=W.chrome&&W.chrome.webview}catch(e){}
if(TOP){
  if(MSG&&typeof send==="function"){
    W.addEventListener("message",function(e){
      var f=document.getElementById(${JSON.stringify(FRAME_ID)});
      if(!f||!f.contentWindow||e.source!==f.contentWindow)return;
      var d=e.data;
      if(!d||d.zn!=="up"||typeof d.s!=="string")return;
      var m;try{m=JSON.parse(d.s)}catch(x){return}
      try{send(JSON.stringify({type:"zinc",n:N,message:m}))}catch(x){}
    });
  }
  return;
}
try{delete W.znMsg}catch(e){}
try{if(W.znMsg)W.znMsg=undefined}catch(e){}
try{if(wv){Object.defineProperty(W.chrome,"webview",{configurable:false,get:function(){return undefined}})}}catch(e){}
if(!MSG||P!==W.top)return;
var zinc={postMessage:function(m){var s;try{s=JSON.stringify(m)}catch(x){return}if(typeof s==="string")P.postMessage({zn:"up",s:s},"*")},onmessage:null};
try{Object.defineProperty(W,"zinc",{configurable:true,get:function(){return zinc},set:function(){}})}catch(e){W.zinc=zinc}
W.addEventListener("message",function(e){
  if(e.source!==P)return;
  var d=e.data;
  if(!d||d.zn!=="down")return;
  var f=zinc.onmessage;
  if(typeof f==="function")try{f.call(zinc,d.m)}catch(x){}
});
})();`;
}

/** The script that delivers a plugin's message to the frame, or null when `raw` is not valid JSON. The text of `raw` is never evaluated: only its parse, re-encoded, is. */
export function deliverScript(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	// a string literal: U+2028 and U+2029 are legal inside one (ES2019), and WebView2 is current Chromium
	const lit = JSON.stringify(JSON.stringify(v === undefined ? null : v));
	return `(function(j){var f=document.getElementById(${JSON.stringify(FRAME_ID)});if(window.top!==window||!f||f.tagName!=="IFRAME"||!f.contentWindow)return;var m;try{m=JSON.parse(j)}catch(e){return}f.contentWindow.postMessage({zn:"down",m:m},"*")})(${lit});`;
}

/** What the host binding accepts from the page: only the wrapper's own relay (right nonce) and only while messaging is on. Returns the message as JSON text. */
export function acceptPageMessage(m: { type?: string; n?: unknown; message?: unknown }, nonce: string, messaging: boolean): string | null {
	if (!messaging || m.type !== "zinc" || m.n !== nonce) return null;
	return JSON.stringify(m.message ?? null);
}
