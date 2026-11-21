// Delta-debugging for a failing note: delete nodes, unwrap elements, drop attributes and cut text while the same check still fails.
import { type HChild, type HNode, render } from "./gen";

type Edit =
	| { kind: "remove" | "unwrap"; path: number[] }
	| { kind: "attr"; path: number[]; name: string }
	| { kind: "text"; path: number[]; from: number; to: number };

const isNode = (c: HChild): c is HNode => typeof c !== "string";

function at(tree: HChild[], path: number[]): { list: HChild[]; i: number } {
	let list = tree;
	for (let d = 0; d < path.length - 1; d++) list = (list[path[d]!] as HNode).kids!;
	return { list, i: path[path.length - 1]! };
}

function* edits(list: HChild[], prefix: number[]): Generator<Edit> {
	for (let i = 0; i < list.length; i++) {
		const c = list[i]!;
		const path = [...prefix, i];
		yield { kind: "remove", path };
		if (isNode(c)) {
			if (c.kids?.length) yield { kind: "unwrap", path };
			for (const name of Object.keys(c.attrs ?? {})) yield { kind: "attr", path, name };
			if (c.kids) yield* edits(c.kids, path);
		} else {
			const n = c.length;
			if (n > 1) {
				yield { kind: "text", path, from: 0, to: n >> 1 };
				yield { kind: "text", path, from: n >> 1, to: n };
				if (n <= 24) for (let k = 0; k < n; k++) yield { kind: "text", path, from: k, to: k + 1 };
			}
		}
	}
}

function apply(tree: HChild[], e: Edit): HChild[] {
	const t = structuredClone(tree);
	const { list, i } = at(t, e.path);
	const c = list[i]!;
	switch (e.kind) {
		case "remove":
			list.splice(i, 1);
			break;
		case "unwrap":
			list.splice(i, 1, ...((c as HNode).kids ?? []));
			break;
		case "attr":
			delete (c as HNode).attrs![e.name];
			break;
		case "text":
			list[i] = (c as string).slice(0, e.from) + (c as string).slice(e.to);
			break;
	}
	return t;
}

export const renderTree = (tree: HChild[], sep: string) => tree.map(render).join(sep);

/** The smallest tree found (within `budget` predicate calls) for which `fails(html)` still holds. */
export async function shrink(
	tree: HChild[],
	sep: string,
	fails: (html: string) => Promise<boolean>,
	budget = 500,
): Promise<{ tree: HChild[]; html: string; tries: number }> {
	let cur = tree;
	let tries = 0;
	let progress = true;
	while (progress && tries < budget) {
		progress = false;
		// after a success, carry on from the same position in the smaller tree (the edits before it already failed)
		let skip = 0;
		for (;;) {
			let hit = false;
			let idx = 0;
			for (const e of edits(cur, [])) {
				if (idx++ < skip) continue;
				if (tries++ >= budget) break;
				const next = apply(cur, e);
				if (await fails(renderTree(next, sep))) {
					cur = next;
					progress = hit = true;
					skip = idx - 1;
					break;
				}
			}
			if (!hit || tries >= budget) break;
		}
	}
	return { tree: cur, html: renderTree(cur, sep), tries };
}
