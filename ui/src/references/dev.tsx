// Dev/test page for the References panel (served by ui/references-mock.ts at /app/).
// ?key=TEST (default) | EMPTY | FAIL | SLOW | BIG (150 refs, virtualised)
import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { Toaster } from "~/components/ui/sonner";
import "~/styles.css";
import { ReferencesPanel } from "./ReferencesPanel";

const key = new URLSearchParams(location.search).get("key") ?? "TEST";

function Dev() {
	const [calls, setCalls] = createSignal<string[]>([]);
	const [focus, setFocus] = createSignal<{ index: number } | null>(null);
	const log = (s: string) => {
		setCalls((c) => [...c, s]);
		((window as any).__calls ??= []).push(s);
	};
	return (
		<div class="flex h-screen">
			<main class="flex-1 space-y-3 p-6 text-sm">
				<h1 class="text-base font-semibold">Reader tab stand-in</h1>
				<p class="text-muted-foreground">The panel sits on the right, as it would beside a reader tab.</p>
				<div class="flex gap-2">
					<button class="rounded border px-2 py-1" data-testid="show-7" onClick={() => setFocus({ index: 7 })}>show-references 7</button>
					<button class="rounded border px-2 py-1" data-testid="show-120" onClick={() => setFocus({ index: 120 })}>show-references 120</button>
				</div>
				<pre class="rounded border bg-muted/40 p-2 text-xs" data-testid="calls">
					<For each={calls()} fallback="(no onOpenItem calls yet)">{(c) => <div>{c}</div>}</For>
				</pre>
			</main>
			<aside class="w-[380px] border-l">
				<ReferencesPanel itemKey={key} focus={focus()} onOpenItem={(k) => log(`onOpenItem ${k}`)} onAdded={(i, k) => log(`onAdded ${i} ${k}`)} />
			</aside>
			<Toaster />
		</div>
	);
}

render(() => <Dev />, document.getElementById("root")!);
