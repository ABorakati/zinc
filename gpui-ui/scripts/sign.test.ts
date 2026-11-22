// needsSigning (scripts/sign.ts): which package files the installer build signs when a certificate is configured. The verifier is
// injected, so nothing here runs signtool or signs anything.
import { describe, expect, test } from "bun:test";
import { needsSigning } from "./sign";

const verdict = (present: boolean, trusted: boolean) => () => ({ present, trusted });

describe("needsSigning", () => {
	test("a file without a signature is signed", () => {
		expect(needsSigning("a.exe", verdict(false, false))).toBe(true);
	});
	test("a file signed by a certificate this machine does not trust (a test certificate) is signed again", () => {
		expect(needsSigning("a.exe", verdict(true, false))).toBe(true);
	});
	test("a file with a trusted signature is left alone", () => {
		expect(needsSigning("a.exe", verdict(true, true))).toBe(false);
	});
	test("a file that cannot be verified is signed", () => {
		expect(
			needsSigning("a.exe", () => {
				throw new Error("signtool.exe not found");
			}),
		).toBe(true);
	});
	test("the verifier is asked about the file given", () => {
		const asked: string[] = [];
		needsSigning("x.dll", (f) => {
			asked.push(f);
			return { present: true, trusted: true };
		});
		expect(asked).toEqual(["x.dll"]);
	});
});
