// Date entry as three separate parts (Year / Month / Day) instead of a calendar: type or step the
// year, pick month and day from short lists. Any part may stay empty ("2024", "April 2024").
// Values are written as YYYY, YYYY-MM or YYYY-MM-DD; with allowText, Zotero-style free text
// ("Spring 2020", "in press") can still be entered via "Edit as text".
import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import { CalendarDays, Type } from "lucide-solid";
import { parseDate } from "../itempane/ctx";
import { cn } from "~/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const daysIn = (y: number, m: number) => new Date(Number.isFinite(y) && y > 0 ? y : 2000, m, 0).getDate();
const pad = (n: string | number) => String(n).padStart(2, "0");

export function formatDateParts(y: string, m: string, d: string): string {
	if (!/^\d{1,4}$/.test(y)) return "";
	const yy = y.padStart(4, "0");
	if (!m) return yy;
	if (!d) return `${yy}-${pad(m)}`;
	return `${yy}-${pad(m)}-${pad(d)}`;
}

/** True when the text is fully represented by year/month/day parts (so nothing is lost by editing them). */
function isPlainDate(v: string): boolean {
	const t = v.trim();
	if (!t) return true;
	const p = parseDate(t);
	if (!p?.y) return false;
	return formatDateParts(p.y, p.m ?? "", p.d ?? "") === t || /^\d{4}([-/.]\d{1,2}){0,2}$/.test(t) ||
		/^(\d{1,2}\s+)?[A-Za-z]{3,9}\.?,?\s+(\d{1,2}(st|nd|rd|th)?,?\s+)?\d{4}$/.test(t);
}

const selectCls =
	"h-7 min-w-0 flex-1 basis-0 rounded-md border border-input bg-background px-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

export const DateParts: Component<{
	value: string;
	onChange: (value: string) => void;
	allowText?: boolean; // offer "Edit as text" for free-text dates (default true)
	ariaLabel?: string;
	class?: string;
}> = (p) => {
	const parsed = () => parseDate(p.value) ?? {};
	const [y, setY] = createSignal(parsed().y ?? "");
	const [m, setM] = createSignal(parsed().m ?? "");
	const [d, setD] = createSignal(parsed().d ?? "");
	const [textMode, setTextMode] = createSignal(!isPlainDate(p.value));
	const [text, setText] = createSignal(p.value);

	// Follow external changes (another item selected, save round trip).
	createEffect(on(() => p.value, (v) => {
		const q = parseDate(v) ?? {};
		setY(q.y ?? ""); setM(q.m ?? ""); setD(q.d ?? ""); setText(v);
		if (!isPlainDate(v)) setTextMode(true);
	}, { defer: true }));

	const commit = (ny = y(), nm = m(), nd = d()) => {
		// Keep the day valid for the month/year (e.g. 31 -> 30 for April, 29 Feb in non-leap years).
		if (nd && nm && +nd > daysIn(+ny, +nm)) nd = String(daysIn(+ny, +nm));
		if (!nm) nd = "";
		setY(ny); setM(nm); setD(nd);
		const out = ny ? formatDateParts(ny, nm, nd) : "";
		if (out !== p.value.trim()) p.onChange(out);
	};

	const stepYear = (delta: number) => {
		const cur = /^\d{1,4}$/.test(y()) ? +y() : new Date().getFullYear();
		commit(String(Math.max(1, cur + delta)), m(), d());
	};

	const dayCount = () => (m() ? daysIn(+y(), +m()) : 31);

	return (
		<div class={cn("flex min-w-0 items-center gap-1", p.class)} role="group" aria-label={p.ariaLabel ?? "Date"}>
			<Show when={!textMode()} fallback={
				<input
					class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
					value={text()}
					placeholder="e.g. Spring 2020, in press"
					aria-label={(p.ariaLabel ?? "Date") + " as text"}
					onInput={(e) => setText(e.currentTarget.value)}
					onBlur={() => text().trim() !== p.value.trim() && p.onChange(text().trim())}
					onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setText(p.value); e.currentTarget.blur(); } }}
				/>
			}>
				<input
					class="h-7 w-[3.3rem] flex-none rounded-md border border-input bg-background px-1.5 text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
					inputmode="numeric"
					maxLength={4}
					placeholder="Year"
					aria-label="Year"
					title="Type a year, or use ↑ / ↓"
					value={y()}
					onInput={(e) => setY(e.currentTarget.value.replace(/\D/g, ""))}
					onBlur={() => commit()}
					onKeyDown={(e) => {
						if (e.key === "ArrowUp") { e.preventDefault(); stepYear(1); }
						else if (e.key === "ArrowDown") { e.preventDefault(); stepYear(-1); }
						else if (e.key === "Enter") e.currentTarget.blur();
					}}
				/>
				<select class={selectCls} aria-label="Month" value={m()} disabled={!y()} onChange={(e) => commit(y(), e.currentTarget.value, d())}>
					<option value="">Month</option>
					<For each={MONTHS}>{(name, i) => <option value={String(i() + 1)}>{name}</option>}</For>
				</select>
				<select class={selectCls} aria-label="Day" value={d()} disabled={!m()} onChange={(e) => commit(y(), m(), e.currentTarget.value)}>
					<option value="">Day</option>
					<For each={Array.from({ length: dayCount() }, (_, i) => String(i + 1))}>{(n) => <option value={n}>{n}</option>}</For>
				</select>
			</Show>
			<Show when={p.allowText ?? true}>
				<button
					type="button"
					class="inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
					title={textMode() ? "Pick year, month and day" : "Edit as text"}
					aria-label={textMode() ? "Pick year, month and day" : "Edit as text"}
					onClick={() => setTextMode(!textMode())}
				>
					{textMode() ? <CalendarDays /> : <Type />}
				</button>
			</Show>
		</div>
	);
};
