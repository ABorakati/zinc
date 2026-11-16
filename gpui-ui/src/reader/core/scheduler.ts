// Work queue in front of a document's worker thread. The Rust worker runs jobs in FIFO order and cannot reorder or drop a
// queued job except by flag, so the JS side keeps the queue and submits at most `max` jobs at a time, always the most urgent
// one (priority is a function evaluated when a slot frees, so it follows the viewport: after a fast scroll the tiles that are
// on screen now go before the ones that were wanted a second ago).
//
// Priority bands (lower runs first): 0 visible tiles, 1 margin tiles, 2 text layers + links of mounted pages, 3 thumbnails,
// 4 outline / prefetch. Within a band: distance from the viewport centre.
export interface Task {
	/** lower = sooner; re-evaluated every time a slot is free */
	pri: () => number;
	run: () => Promise<void>;
	/** called when the task is dropped from the queue before it ran */
	dropped?: () => void;
}
export interface Handle {
	cancel(): void;
}

export class Scheduler {
	private queue: Task[] = [];
	private running = 0;
	/** tasks started / finished, for scripts waiting for idle */
	started = 0;
	finished = 0;
	constructor(private max = 2) {}

	add(t: Task): Handle {
		this.queue.push(t);
		queueMicrotask(() => this.pump());
		return {
			cancel: () => {
				const i = this.queue.indexOf(t);
				if (i >= 0) {
					this.queue.splice(i, 1);
					t.dropped?.();
				}
			},
		};
	}

	get pending(): number {
		return this.queue.length + this.running;
	}

	clear(): void {
		const q = this.queue;
		this.queue = [];
		for (const t of q) t.dropped?.();
	}

	private pump(): void {
		while (this.running < this.max && this.queue.length) {
			let best = 0,
				bp = Infinity;
			for (let i = 0; i < this.queue.length; i++) {
				const p = this.queue[i]!.pri();
				if (p < bp) {
					bp = p;
					best = i;
				}
			}
			const t = this.queue.splice(best, 1)[0]!;
			this.running++;
			this.started++;
			void t
				.run()
				.catch((e) => console.error("[reader]", e instanceof Error ? e.message : e))
				.finally(() => {
					this.running--;
					this.finished++;
					this.pump();
				});
		}
	}
}
