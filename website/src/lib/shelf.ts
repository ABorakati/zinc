// The shelf of bound volumes: one spine per feature group. The first six are the README's "## Features" groups (their
// anchors on the features page come from the same titles); the last two point into the docs.
import { section, subsections } from "./readme";

export const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

export interface Volume {
	title: string;
	spine: string;
	href: string;
	cloth: string;
	call: string;
	height: number;
	width: number;
}

// bindings in the app's own collection colours (gpui-ui/src/sidebar/collectionStyle.ts)
const CLOTHS = ["blue", "rust", "green", "amber", "violet", "sky", "rose", "slate"];
// spine shapes vary like a real run of volumes (rem)
const HEIGHTS = [20, 18.25, 21, 17.5, 19.5, 18.75, 21.5, 17.75];
const WIDTHS = [5, 4.3, 5.6, 4.6, 5.3, 4.2, 4.9, 4.5];
const SHORT: Record<string, string> = {
	"Getting references in and out": "In & out",
	"Sync and storage": "Sync & storage",
	"Notes and web": "Notes & web",
	"Around the app": "Around the app",
};

export function volumes(base: string): Volume[] {
	const groups = subsections(section("## Features")).map((g) => g.title);
	const list = [
		...groups.map((t) => ({ title: t, href: `${base}features/#${slug(t)}` })),
		{ title: "Word add-in", href: `${base}user-guide/word/` },
		{ title: "MCP for agents", href: `${base}user-guide/mcp/` },
	];
	return list.map((v, i) => ({
		...v,
		spine: SHORT[v.title] ?? v.title,
		cloth: CLOTHS[i % CLOTHS.length],
		call: `ZN ${i + 1}`,
		height: HEIGHTS[i % HEIGHTS.length],
		width: WIDTHS[i % WIDTHS.length],
	}));
}

export const roman = (n: number) =>
	[
		["M", 1000],
		["CM", 900],
		["D", 500],
		["CD", 400],
		["C", 100],
		["XC", 90],
		["L", 50],
		["XL", 40],
		["X", 10],
		["IX", 9],
		["V", 5],
		["IV", 4],
		["I", 1],
	].reduce((acc, [s, v]) => {
		while (n >= (v as number)) {
			acc += s;
			n -= v as number;
		}
		return acc;
	}, "");
