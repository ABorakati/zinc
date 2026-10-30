// Tiny DOM helpers, injected CSS and the shared popup used by academic/ (vanilla DOM: no framework coupling).

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, any> | null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (props) {
		for (const [k, v] of Object.entries(props)) {
			if (v == null || v === false) continue;
			if (k === "class") el.className = v;
			else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
			else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
			else if (k === "text") el.textContent = v;
			else el.setAttribute(k, v === true ? "" : String(v));
		}
	}
	for (const c of children) if (c) el.append(c);
	return el;
}

const CSS = `
.rn-pop{position:fixed;z-index:10000;width:min(420px,calc(100vw - 16px));max-height:min(70vh,520px);overflow:auto;box-sizing:border-box;
 background:var(--popover,Canvas);color:var(--popover-foreground,CanvasText);border:1px solid var(--border,rgba(128,128,128,.35));
 border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.22);padding:10px 12px;font:12px/1.4 system-ui,sans-serif}
.rn-pop *{box-sizing:border-box}
.rn-title{font-size:13px;font-weight:600;line-height:1.3;margin:0 0 3px}
.rn-meta{color:var(--muted-foreground,GrayText);margin-bottom:6px}
.rn-abs{max-height:130px;overflow:auto;margin:6px 0;line-height:1.45;opacity:.9}
.rn-skel{height:9px;border-radius:4px;background:var(--muted,rgba(128,128,128,.2));margin:5px 0;animation:rnpulse 1.2s ease-in-out infinite}
@keyframes rnpulse{50%{opacity:.4}}
.rn-row{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.rn-btn{font:inherit;font-size:11px;line-height:1.2;padding:4px 8px;border-radius:6px;cursor:pointer;
 color:var(--foreground,inherit);background:transparent;border:1px solid var(--input,rgba(128,128,128,.4))}
.rn-btn:hover:not(:disabled){background:var(--accent,rgba(128,128,128,.15))}
.rn-btn:disabled{opacity:.5;cursor:default}
.rn-btn.rn-primary{background:var(--primary,#2563eb);color:var(--primary-foreground,#fff);border-color:transparent}
.rn-btn.rn-primary:hover:not(:disabled){filter:brightness(1.1);background:var(--primary,#2563eb)}
.rn-badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:99px;background:var(--success,#dcfce7);color:var(--success-foreground,#166534);margin-left:6px;vertical-align:1px}
.rn-note{color:var(--muted-foreground,GrayText);font-style:italic;margin:4px 0}
.rn-raw{margin:4px 0;opacity:.85;white-space:pre-wrap;word-break:break-word}
.rn-list>.rn-li{border-top:1px solid var(--border,rgba(128,128,128,.25));padding:6px 0;cursor:pointer}
.rn-list>.rn-li:first-child{border-top:0}
.rn-li:hover>.rn-li-head{color:var(--primary,#2563eb)}
.rn-li-head{display:flex;gap:6px}.rn-li-num{color:var(--muted-foreground,GrayText);min-width:2.2em;font-variant-numeric:tabular-nums}
.rn-li-body{margin:6px 0 2px 2.2em;cursor:default}
.rn-hot{position:absolute;pointer-events:auto;cursor:help;border-bottom:1.5px dotted var(--primary,#2563eb);background:transparent;border-radius:2px}
.rn-hot:hover{background:color-mix(in oklab,var(--primary,#2563eb) 18%,transparent)}
.rn-tab{height:100%;display:flex;flex-direction:column;font:12px/1.4 system-ui,sans-serif;color:var(--foreground,inherit)}
.rn-tab-head{padding:8px 10px;border-bottom:1px solid var(--border,rgba(128,128,128,.25));display:flex;gap:6px;align-items:center}
.rn-input{flex:1;min-width:0;font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--input,rgba(128,128,128,.4));background:var(--background,Canvas);color:inherit}
.rn-scroll{flex:1;overflow:auto}
.rn-sec{padding:6px 10px 3px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground,GrayText);position:sticky;top:0;background:var(--background,Canvas);z-index:1}
.rn-item{display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border,rgba(128,128,128,.18));cursor:pointer;text-align:left;align-items:flex-start}
.rn-item:hover,.rn-item:focus-visible{background:var(--accent,rgba(128,128,128,.12));outline:none}
.rn-item.rn-flash{background:color-mix(in oklab,var(--primary,#2563eb) 20%,transparent)}
.rn-thumb{width:64px;height:48px;flex:none;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,.3));background:var(--muted,rgba(128,128,128,.12));object-fit:contain;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--muted-foreground,GrayText);font-size:16px}
.rn-thumb canvas,.rn-thumb img{max-width:100%;max-height:100%}
.rn-figitem{flex-direction:column;gap:6px}
.rn-thumb.rn-thumb-lg{width:100%;height:auto;min-height:90px;max-height:260px;background:#fff;font-size:22px}
.rn-thumb.rn-thumb-lg canvas{width:auto!important;max-width:100%;max-height:258px;height:auto}
.rn-ctx-list{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow-y:auto;margin-top:2px}
.rn-ctx{display:block;width:100%;text-align:left;font:inherit;line-height:1.4;color:inherit;background:transparent;border:1px solid var(--border,rgba(128,128,128,.3));border-radius:6px;padding:6px 8px;cursor:pointer}
.rn-ctx:hover{background:rgba(37,99,235,.07);border-color:rgba(37,99,235,.45)}
.rn-ctx-pg{float:right;margin-left:8px;font-size:11px;color:var(--muted-foreground,GrayText)}
.rn-ctx mark{background:rgba(37,99,235,.18);color:inherit;font-weight:600;border-radius:2px;padding:0 1px}
.rn-fig-preview{display:flex;justify-content:center;background:#fff;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,.3));margin:6px 0;overflow:hidden}
.rn-fig-preview canvas{width:auto!important;max-width:100%;max-height:300px;height:auto}
.rn-cite{position:absolute;pointer-events:none;border-radius:2px;background:rgba(37,99,235,.20);box-shadow:inset 0 -2px 0 rgba(37,99,235,.85);mix-blend-mode:multiply}
.rn-ico{width:28px;height:34px;flex:none;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,.3));background:var(--muted,rgba(128,128,128,.12));display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;letter-spacing:.03em;color:var(--muted-foreground,GrayText)}
.rn-grow{flex:1;min-width:0}
.rn-lbl{font-weight:600}
.rn-cap{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--muted-foreground,GrayText)}
.rn-pg{color:var(--muted-foreground,GrayText);font-size:10px;margin-left:4px;font-weight:400}
.rn-empty{padding:16px 12px;color:var(--muted-foreground,GrayText)}
.rn-preview{display:block;max-width:100%;max-height:160px;margin-top:6px;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,.3))}
`;

let styleEl: HTMLStyleElement | null = null;
let styleRefs = 0;
export function useStyles(): () => void {
	if (!styleEl) {
		styleEl = document.createElement("style");
		styleEl.textContent = CSS;
		document.head.appendChild(styleEl);
	}
	styleRefs++;
	return () => {
		if (--styleRefs === 0) { styleEl?.remove(); styleEl = null; }
	};
}

export function button(label: string, onClick: (b: HTMLButtonElement) => void, opts: { primary?: boolean; title?: string } = {}): HTMLButtonElement {
	const b = h("button", { type: "button", class: "rn-btn" + (opts.primary ? " rn-primary" : ""), title: opts.title }, label);
	b.addEventListener("pointerdown", (e) => e.stopPropagation());
	b.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick(b);
	});
	return b;
}

/** One floating popup at a time. Hover popups close shortly after the pointer leaves; pinned ones stay until Esc/outside click. */
export class PopupManager {
	private el: HTMLElement | null = null;
	private hideTimer: ReturnType<typeof setTimeout> | undefined;
	private current: string | null = null;
	pinned = false;
	private off: (() => void)[] = [];

	constructor() {
		const onDown = (e: PointerEvent) => {
			if (this.el && !this.el.contains(e.target as Node)) this.hide();
		};
		document.addEventListener("pointerdown", onDown, true);
		this.off.push(() => document.removeEventListener("pointerdown", onDown, true));
	}

	get isOpen() { return !!this.el; }
	get key() { return this.current; }

	show(key: string, at: { x: number; y: number }, content: HTMLElement, pinned: boolean) {
		clearTimeout(this.hideTimer);
		if (this.el && this.current === key) {
			this.pinned = this.pinned || pinned;
			return;
		}
		this.hide();
		const el = h("div", { class: "rn-pop", role: "dialog", "data-testid": "rn-popup" }, content);
		el.addEventListener("pointerenter", () => clearTimeout(this.hideTimer));
		el.addEventListener("pointerleave", () => { if (!this.pinned) this.scheduleHide(350); });
		document.body.appendChild(el);
		this.el = el;
		this.current = key;
		this.pinned = pinned;
		this.place(at);
		// content may grow (abstract arrives): keep it on screen
		const ro = new ResizeObserver(() => this.place(at));
		ro.observe(el);
		this.off.push(() => ro.disconnect());
	}

	private place(at: { x: number; y: number }) {
		const el = this.el;
		if (!el) return;
		const m = 8;
		const w = el.offsetWidth;
		const hh = el.offsetHeight;
		let left = Math.min(Math.max(m, at.x - 24), window.innerWidth - w - m);
		let top = at.y + 16;
		if (top + hh > window.innerHeight - m) top = Math.max(m, at.y - hh - 12);
		el.style.left = left + "px";
		el.style.top = top + "px";
	}

	scheduleHide(ms = 300) {
		if (this.pinned) return;
		clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => this.hide(), ms);
	}

	cancelHide() { clearTimeout(this.hideTimer); }

	hide() {
		clearTimeout(this.hideTimer);
		this.el?.remove();
		this.el = null;
		this.current = null;
		this.pinned = false;
	}

	dispose() {
		this.hide();
		for (const f of this.off) f();
		this.off = [];
	}
}
