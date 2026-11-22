// bun test src/itempane/plainDate.test.ts -- which dates the year / month / day boxes can show without losing a word of them.
import { expect, test } from "bun:test";
import { isPlainDate } from "./util";

test("a date with a word that is no month is edited as text", () => {
	for (const d of ["Spring 2020", "Winter, 2019", "circa 2020"]) expect([d, isPlainDate(d)]).toEqual([d, false]);
});

test("dates the boxes can show stay plain", () => {
	for (const d of ["", "2020", "2020-03", "2025-03-04", "Mar 2025", "March 2025", "4 March 2025", "March 4, 2025"]) expect([d, isPlainDate(d)]).toEqual([d, true]);
});
