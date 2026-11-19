// Settings > Appearance > Layout: the default arrangement of the library (shell/frameLayout.ts LIBRARY_PRESETS), a way into edit
// layout mode (shell/layoutEdit.tsx), and resets. Registered after defs/sidebars (settings/index.ts).
import { LIBRARY_PRESETS } from "../../shell/frameLayout";
import { defaultPresetId, resetLayout, setDefaultPreset } from "../../shell/layout";
import { editLayout } from "../../shell/layoutEdit";
import { Select, toast } from "../../ui";
import { Btn } from "../controls";
import { registerSettings } from "../registry";

registerSettings([
	{
		id: "appearance.layout-default",
		section: "appearance",
		group: "Layout",
		label: "Default layout",
		description:
			"How the library is arranged: Standard (sidebar, item list and item details side by side), Stacked (item details below the list) or Triage (a wide list with Tags and Collections beside it). Choosing one arranges the library that way now; Reset layout returns to it.",
		keywords: ["layout", "panes", "stacked", "standard", "triage", "item pane", "arrangement", "default"],
		control: () => (
			<Select
				value={defaultPresetId()}
				options={LIBRARY_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
				onChange={(id) => setDefaultPreset(id)}
				width={180}
			/>
		),
	},
	{
		id: "appearance.layout-customize",
		section: "appearance",
		group: "Layout",
		label: "Customize layout",
		description:
			"Shows a header on every pane in the library, so you can drag panes (and item pane sections) to another place, stack them as tabs or hide them. Press Done or Escape to finish.",
		keywords: ["layout", "customize", "edit", "drag", "dock", "move", "tabs", "panes"],
		control: () => (
			<Btn icon="layout-dashboard" onClick={() => editLayout(true)}>
				Customize…
			</Btn>
		),
	},
	{
		id: "appearance.layout-reset",
		section: "appearance",
		group: "Layout",
		label: "Reset layout",
		description: "Put every pane back where the default layout has it.",
		keywords: ["layout", "reset", "panes", "restore"],
		control: () => (
			<Btn
				onClick={() => {
					if (resetLayout()) toast("Layout reset", { kind: "success" });
				}}
			>
				Reset
			</Btn>
		),
	},
]);
