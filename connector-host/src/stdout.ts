// The native-messaging output channel: a writer that waits when the pipe is full and goes quiet once it is closed.

/** The part of a Node/Bun writable stream the writer uses. */
export interface WriteTarget {
	write(chunk: Uint8Array): boolean;
	on(event: "drain" | "error" | "close", listener: () => void): unknown;
}

/**
 * `write(buf)` resolves when the stream has taken the bytes (its `drain` event when it said it was full). When Chrome has closed
 * the pipe nobody reads the answers: the stream's error or close event ends every wait and later writes are dropped.
 */
export function stdoutWriter(out: WriteTarget): (b: Buffer) => Promise<void> {
	let closed = false;
	const waiting = new Set<() => void>();
	const release = () => {
		for (const w of waiting) w();
		waiting.clear();
	};
	const end = () => {
		closed = true;
		release();
	};
	out.on("drain", release);
	out.on("error", end);
	out.on("close", end);
	return (b) => {
		if (closed) return Promise.resolve();
		let room: boolean;
		try {
			room = out.write(b);
		} catch {
			end();
			return Promise.resolve();
		}
		if (room || closed) return Promise.resolve();
		return new Promise<void>((resolve) => waiting.add(resolve));
	};
}
