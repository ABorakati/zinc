import { batch, createSignal, onCleanup } from "solid-js";
import { api, type ItemQuery, type ItemSummary } from "./api";
import { PAGE } from "./store";

/** Sparse, page-at-a-time cache of the server's item list. */
export function createItemList() {
	let cache = new Map<number, ItemSummary>();
	const inflight = new Set<number>();
	let gen = 0;
	let cacheGen = 0;
	let q: ItemQuery | null = null;
	const [total, setTotal] = createSignal(0);
	const [tick, setTick] = createSignal(0);
	const [epoch, setEpoch] = createSignal(0); // bumped by reset(); lets the view re-request its visible pages
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	async function loadPage(p: number, g: number) {
		if (!q || inflight.has(p) || g !== gen) return;
		inflight.add(p);
		try {
			const res = await api.items(q, p * PAGE, PAGE);
			if (g !== gen) return;
			batch(() => {
				if (cacheGen !== g) { cache = new Map(); cacheGen = g; }
				res.items.forEach((it, i) => cache.set(p * PAGE + i, it));
				setTotal(res.total);
				setError(null);
				setTick((t) => t + 1);
			});
		} catch (e) {
			if (g === gen) setError((e as Error).message);
		} finally {
			inflight.delete(p);
			if (g === gen) setLoading(false);
		}
	}

	/** Restart with a new query; keeps old rows visible until page 0 returns. */
	function reset(query: ItemQuery) {
		gen++;
		setEpoch(gen);
		q = query;
		inflight.clear();
		setLoading(true);
		loadPage(0, gen);
	}

	function ensure(index: number) {
		if (cacheGen === gen && cache.has(index)) return;
		loadPage(Math.floor(index / PAGE), gen);
	}

	onCleanup(() => gen++);

	return {
		total, loading, error, epoch,
		get(i: number): ItemSummary | undefined { tick(); return cache.get(i); },
		ensure, reset,
		patch(key: string, p: Partial<ItemSummary>) {
			for (const [i, it] of cache) if (it.key === key) { cache.set(i, { ...it, ...p }); }
			setTick((t) => t + 1);
		},
	};
}
