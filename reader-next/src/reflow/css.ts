// Styles for the reading view, scoped under .rr-reading. Colours and typography come from CSS variables set on
// the root element (see ReflowView.rootStyle); --rn-reading-bg / --rn-reading-fg are also published on <html>.
export const READING_CSS = `
.rr-reading { position: absolute; inset: 0; background: var(--rn-reading-bg); color: var(--rn-reading-fg); }
.rr-reading-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; scroll-padding-top: 24px; }
.rr-reading-bar { position: absolute; top: 10px; right: 22px; z-index: 5; display: flex; gap: 6px; }
.rr-reading-btn { display: inline-flex; align-items: baseline; gap: 1px; height: 32px; min-width: 34px; padding: 0 10px; justify-content: center; align-items: center;
  border: 1px solid var(--rr-rule); border-radius: 8px; background: var(--rn-reading-bg); color: var(--rr-muted); font: 600 13px/1 system-ui, sans-serif; cursor: pointer; opacity: .92; }
.rr-reading-btn:hover, .rr-reading-btn[aria-expanded=true] { color: var(--rn-reading-fg); border-color: var(--rr-muted); opacity: 1; }
.rr-reading-btn.rr-wide { margin-top: 14px; }
.rr-reading-btn:disabled { opacity: .4; cursor: default; }
.rr-reading-group { display: flex; }
.rr-reading-group .rr-reading-btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.rr-reading-group .rr-reading-btn + .rr-reading-btn { margin-left: -1px; border-top-left-radius: 0; border-bottom-left-radius: 0; }
.rr-missing { display: block; font: 10px/1.2 system-ui, sans-serif; color: var(--rr-muted); }

.rr-article { box-sizing: content-box; max-width: var(--rr-width); margin: 0 auto; padding: 56px 28px 160px;
  font-family: var(--rr-font); font-size: var(--rr-size); line-height: var(--rr-lh); text-align: var(--rr-align); hyphens: var(--rr-hyphens); overflow-wrap: break-word; }
.rr-article > * { margin-top: 0; }
.rr-title { font-size: 1.75em; line-height: 1.22; font-weight: 700; letter-spacing: -.01em; margin: 0 0 .7em; text-align: left; text-wrap: balance; hyphens: manual; }
.rr-h { font-weight: 650; line-height: 1.28; text-align: left; text-wrap: balance; hyphens: manual; }
.rr-h1, .rr-h2 { font-size: 1.38em; margin: 2em 0 .55em; }
.rr-h3 { font-size: 1.16em; margin: 1.7em 0 .45em; }
.rr-h4, .rr-h5 { font-size: 1em; font-style: italic; margin: 1.4em 0 .35em; }
.rr-p { margin: 0 0 .85em; text-wrap: pretty; }
.rr-p sup, .rr-p sub, .rr-list sup, .rr-list sub { line-height: 0; }
.rr-list { margin: 0 0 .9em; }
.rr-list ul, .rr-list ol { margin: 0; padding-left: 1.5em; }
.rr-list li { margin: .25em 0; padding-left: .2em; }
.rr-list ul { list-style: disc; }
.rr-list ol { list-style: decimal; }
.rr-code { margin: 0 0 1.1em; padding: .8em 1em; overflow-x: auto; font: .8em/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace; background: color-mix(in srgb, var(--rn-reading-fg) 6%, transparent); border-radius: 6px; text-align: left; }
.rr-article code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: .88em; }
.rr-notes { margin: 1.2em 0 1.4em; padding-top: .6em; border-top: 1px solid var(--rr-rule); font-size: .82em; line-height: 1.5; color: var(--rr-muted); }
.rr-notes p { margin: 0 0 .4em; }
.rr-refs { margin: 0 0 1em; padding: 0; list-style: none; font-size: .86em; line-height: 1.5; color: var(--rn-reading-fg); text-align: left; hyphens: manual; }
.rr-refs li { margin: 0 0 .5em; padding-left: 2.2em; text-indent: -2.2em; cursor: pointer; border-radius: 3px; transition: background-color .12s; }
/* like the page view: the entry's first line is a dotted link (hover: where it is cited; click: go to the first citation) */
.rr-refs li::first-line { text-decoration: underline dotted var(--rr-cite); text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
.rr-refs li:hover { background: var(--rr-cite-bg); }

.rr-article a { color: var(--rr-cite); text-underline-offset: 2px; }
.rr-article a.rx-cite { text-decoration: none; font-weight: 600; background: var(--rr-cite-bg); border-bottom: 1px solid color-mix(in srgb, var(--rr-cite) 45%, transparent); border-radius: 3px; padding: 0 .2em; margin: 0 .02em; cursor: pointer; box-decoration-break: clone; -webkit-box-decoration-break: clone; transition: background-color .12s; }
.rr-article a.rx-cite[data-kind=other] { font-weight: inherit; background: none; border-bottom: 1px dotted color-mix(in srgb, var(--rr-cite) 55%, transparent); border-radius: 0; }
.rr-article a.rx-cite:hover { text-decoration: underline; background: color-mix(in srgb, var(--rr-cite) 24%, transparent); }

.rr-flash { animation: rr-flash 1.8s ease-out; border-radius: 4px; }
@keyframes rr-flash { 0%, 35% { background: color-mix(in srgb, var(--rr-cite) 22%, transparent); box-shadow: 0 0 0 6px color-mix(in srgb, var(--rr-cite) 22%, transparent); } 100% { background: transparent; box-shadow: 0 0 0 6px transparent; } }

.rr-figure { margin: 1.6em 0 1.8em; text-align: left; hyphens: manual; }
.rr-figure.rr-wide { margin-left: -4%; margin-right: -4%; }
.rr-region { position: relative; width: 100%; margin: 0 auto; }
.rr-fig-img { background: #fff; border-radius: 6px; box-shadow: 0 0 0 1px var(--rr-rule); overflow: hidden; }
.rr-region[data-state=idle], .rr-region[data-state=busy] { background: color-mix(in srgb, var(--rn-reading-fg) 6%, transparent); border-radius: 6px; }
.rr-region[data-state=busy]::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, color-mix(in srgb, var(--rn-reading-fg) 9%, transparent) 50%, transparent 70%); background-size: 220% 100%; animation: rr-shimmer 1.3s linear infinite; }
@keyframes rr-shimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
.rr-region-err { position: absolute; inset: 0; display: grid; place-items: center; font: 12px system-ui, sans-serif; color: var(--rr-muted); }
.rr-figure figcaption { margin-top: .7em; font-size: .84em; line-height: 1.5; color: var(--rr-muted); }
.rr-figure figcaption::first-line { color: var(--rn-reading-fg); }
.rr-viewpage { margin-top: .5em; padding: 0; border: 0; background: none; font: 600 11.5px/1.2 system-ui, sans-serif; color: var(--rr-cite); cursor: pointer; letter-spacing: .01em; }
.rr-viewpage:hover { text-decoration: underline; }
.rr-equation { margin: .9em 0 1.1em; text-align: center; }
.rr-equation .rr-region { display: block; }
.rr-eq canvas { mix-blend-mode: multiply; }
.rr-eq-dark canvas { filter: invert(1) hue-rotate(180deg); mix-blend-mode: screen; }
.rr-empty { color: var(--rr-muted); text-align: center; margin-top: 20vh; }

.rr-status { max-width: 460px; margin: 22vh auto 0; padding: 0 24px; text-align: center; font: 14px/1.5 system-ui, sans-serif; color: var(--rr-muted); }
.rr-status-title { font-size: 16px; font-weight: 600; color: var(--rn-reading-fg); margin-bottom: 6px; }
.rr-status-sub { font-size: 13px; }
.rr-progress { height: 4px; border-radius: 2px; background: var(--rr-rule); margin: 18px 0 8px; overflow: hidden; }
.rr-progress-bar { height: 100%; background: var(--rr-cite); border-radius: 2px; transition: width .3s ease; }

.rr-pop { position: absolute; top: 48px; right: 22px; z-index: 6; width: 340px; max-width: calc(100% - 32px); max-height: calc(100% - 64px); overflow-y: auto; box-sizing: border-box; padding: 14px 16px 12px; border-radius: 12px;
  background: var(--rn-reading-bg); color: var(--rn-reading-fg); border: 1px solid var(--rr-rule); box-shadow: 0 12px 34px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.1);
  font: 13px/1.35 system-ui, "Segoe UI", sans-serif; }
.rr-pop-h { margin: 10px 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--rr-muted); }
.rr-pop-h:first-child { margin-top: 0; }
.rr-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.rr-seg button, .rr-theme { padding: 7px 8px; border: 1px solid var(--rr-rule); border-radius: 8px; background: transparent; color: inherit; font-size: 13px; cursor: pointer; text-align: center; }
.rr-seg button:hover, .rr-theme:hover { border-color: var(--rr-muted); }
.rr-seg button.on, .rr-theme.on { border-color: var(--rr-cite); box-shadow: 0 0 0 1px var(--rr-cite); }
.rr-text { width: 100%; margin-top: 8px; padding: 6px 8px; border: 1px solid var(--rr-rule); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
.rr-hint { margin-top: 6px; font-size: 11.5px; color: var(--rr-muted); }
.rr-row { display: grid; grid-template-columns: 74px 1fr 52px; align-items: center; gap: 8px; margin-top: 9px; }
.rr-row-label { color: var(--rr-muted); }
.rr-row-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--rr-muted); }
.rr-row input[type=range] { width: 100%; accent-color: var(--rr-cite); }
.rr-themes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.rr-theme { position: relative; font-size: 12px; display: grid; place-items: center; }
.rr-theme input[type=color] { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.rr-check { display: flex; align-items: center; gap: 8px; margin-top: 14px; cursor: pointer; }
.rr-check input { accent-color: var(--rr-cite); }
.rr-reset { margin-top: 12px; padding: 0; border: 0; background: none; color: var(--rr-muted); font-size: 11.5px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.rr-reset:hover { color: var(--rn-reading-fg); }
@media (max-width: 720px) { .rr-article { padding: 48px 18px 120px; } }
`;
