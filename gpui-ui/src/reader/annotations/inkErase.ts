// Pure path erasing for ink annotations (the eraser tool in ink.tsx).

/** Does the point (px, py) lie inside the eraser circle at (ex, ey)? */
const hits = (px: number, py: number, ex: number, ey: number, radius: number) => Math.hypot(px - ex, py - ey) <= radius;

/**
 * Erase the parts of `strokes` (flat [x0, y0, x1, y1, ...] paths) that lie inside the circle at (ex, ey). A stroke the circle does not
 * touch is kept as the same array, once. A touched stroke is replaced by its surviving runs of at least two points (a stroke cut in
 * the middle becomes two); a stroke with nothing left disappears. `changed` is false when nothing was touched.
 */
export function erasePaths(strokes: number[][], ex: number, ey: number, radius = 12): { paths: number[][]; changed: boolean } {
	const paths: number[][] = [];
	let changed = false;
	for (const stroke of strokes) {
		let run: number[] = [];
		let touched = false;
		const runs: number[][] = [];
		for (let i = 0; i + 1 < stroke.length; i += 2) {
			const px = stroke[i]!,
				py = stroke[i + 1]!;
			if (hits(px, py, ex, ey, radius)) {
				touched = true;
				if (run.length >= 4) runs.push(run);
				run = [];
			} else {
				run.push(px, py);
			}
		}
		if (!touched) {
			paths.push(stroke);
			continue;
		}
		changed = true;
		if (run.length >= 4) runs.push(run);
		paths.push(...runs);
	}
	return { paths, changed };
}
