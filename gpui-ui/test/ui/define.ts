// How a UI scenario is written: see test/ui/scenarios/*.ui.ts.
//
//   scenario("what must hold", async (ui) => {
//     await ui.click("ZT01");
//     await ui.expect("ZT01 is selected", () => ui.selectedTitle(), "ZT01 Three authors");
//   });
import type { Ui } from "./driver";

export interface ScenarioOptions {
	/** Extra items in the library: 130 by default (more than one page of the list). */
	items?: number;
	/** The inside of the window, 1440 x 881 by default (the size the scenarios were written against; the harness sets it on Windows). */
	width?: number;
	height?: number;
	/** Light or dark (dark by default, so that a run does not follow the machine). */
	mode?: "light" | "dark";
	/**
	 * A bug that is known and not fixed yet, with the reason it waits. The scenario still runs: it must fail, and when it starts to
	 * pass the run says so, so that the mark is taken off.
	 */
	knownBug?: string;
	/**
	 * The reason this scenario can only run in the in-process mode (it needs ui.renderer, or a thing the real app does not give). In the
	 * real-app mode (--app) it is skipped and counted apart.
	 */
	inProcessOnly?: string;
}

export interface Scenario {
	name: string;
	run: (ui: Ui) => Promise<void>;
	options: ScenarioOptions;
}

export const scenarios: Scenario[] = [];

export function scenario(name: string, run: (ui: Ui) => Promise<void>, options: ScenarioOptions = {}): void {
	if (scenarios.some((s) => s.name === name)) throw new Error(`two scenarios are called "${name}"`);
	scenarios.push({ name, run, options });
}
