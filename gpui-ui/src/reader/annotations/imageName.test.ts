// bun test src/reader/annotations/imageName.test.ts -- an exported image annotation is always saved inside the folder that was picked.
import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import { annotationImageName } from "./imageExport";
import type { Annotation } from "./model";

const ann = (id: string, pageLabel: string | undefined, pageIndex = 2) =>
	({ id, pageLabel, position: { pageIndex }, type: "image", color: "#fff", sortIndex: "", dateModified: "" }) as unknown as Annotation;

describe("annotationImageName", () => {
	test("an ordinary annotation keeps its name", () => {
		expect(annotationImageName(ann("ABCD1234", "12"))).toBe("annotation-ABCD1234-p12.png");
		expect(annotationImageName(ann("ABCD1234", undefined, 4))).toBe("annotation-ABCD1234-p5.png");
		expect(annotationImageName(ann("ABCD1234", "iv"))).toBe("annotation-ABCD1234-piv.png");
		expect(annotationImageName(ann("ABCD1234", "S1.2"))).toBe("annotation-ABCD1234-pS1.2.png");
	});

	test("a page label or id with path pieces cannot leave the folder", () => {
		const dir = resolve("C:/exports/images");
		for (const bad of ["../../x", ["..", "..", "x"].join(String.fromCharCode(92)), "a/b", "x/../../escape", "c:evil", "..", "/etc/passwd", "x\0y", "a:b:c", "\u202e..", "....//"]) {
			for (const a of [ann("ID000001", bad), ann(bad, "3")]) {
				const name = annotationImageName(a);
				expect(name).not.toMatch(/[\/:\0]/);
				const target = join(dir, name);
				expect(relative(dir, target).startsWith("..")).toBe(false);
				expect(resolve(dir, name)).toBe(target);
			}
		}
	});

	test("an empty or very long piece still gives a usable name", () => {
		expect(annotationImageName(ann("", "7"))).toBe("annotation-_-p7.png");
		expect(annotationImageName(ann("A".repeat(500), "7")).length).toBeLessThan(100);
	});
});
