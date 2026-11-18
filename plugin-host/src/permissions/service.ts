// `permissions.request`: the run-time prompt for an optional permission. The prompt itself is the ui area's (a `where: "zinc"` hook
// that shows a dialog with the reason and the risk tier); until it exists the app passes a function, or the call returns `unavailable`.
import type { PluginManifest } from "../manifest";
import { WitError } from "../imports/registry";
import type { Grants } from "../manifest";
import { NET_PREFIX, permissionTier, type RiskTier } from "./risk";
import { permissionState } from "./store";

export interface PermissionPromptRequest {
	pluginId: string;
	pluginName: string;
	manifest: PluginManifest;
	permission: string;
	tier: RiskTier;
	/** The plugin's `reason`, already resolved to text in the UI language. */
	reason: string;
}

/** Shows the dialog and waits. true: the user granted it. */
export type PermissionPrompt = (req: PermissionPromptRequest) => Promise<boolean> | boolean;

export interface PermissionServiceDeps {
	prompt?: PermissionPrompt;
	/** Refuse unless a Zinc window is focused and the user acted in the last 10 s (lifecycle.wit). Default: allow (the ui area supplies the real gate). */
	canPrompt?: (plugin: string) => boolean;
	grant: (plugin: string, permission: string) => Promise<void>;
	resolveReason: (plugin: string, reason: unknown) => string;
}

export class PermissionService {
	prompt: PermissionPrompt | undefined;
	canPrompt: ((plugin: string) => boolean) | undefined;
	private pending = new Map<string, Promise<boolean>>();

	constructor(private d: PermissionServiceDeps) {
		this.prompt = d.prompt;
		this.canPrompt = d.canPrompt;
	}

	/** `permissions.request`. Returns whether the permission is granted afterwards. */
	async request(manifest: PluginManifest, grants: Readonly<Grants>, permission: string, reason: unknown): Promise<boolean> {
		const id = manifest.id;
		const state = permissionState(manifest, grants, permission);
		if (state === "granted") return true;
		if (state === "undeclared") throw new WitError("permission-denied", permission);
		if (state === "denied") throw new WitError("invalid-argument", `${permission} is not an optional permission; the user turned it off in Settings > Plugins`);
		if (permission === "net.hosts") throw new WitError("invalid-argument", 'ask for one host at a time: "net.hosts:<entry>"');
		if (!this.prompt) throw new WitError("unavailable", "no permission prompt is available in this build");
		if (this.canPrompt && !this.canPrompt(id)) throw new WitError("permission-denied", `${permission}: a request needs a focused Zinc window and a user action in the last 10 s`);
		const key = `${id}\0${permission}`;
		let p = this.pending.get(key);
		if (!p) {
			p = Promise.resolve(
				this.prompt({
					pluginId: id,
					pluginName: manifest.name,
					manifest,
					permission,
					tier: permissionTier(permission) ?? (permission.startsWith(NET_PREFIX) ? "medium" : "high"),
					reason: this.d.resolveReason(id, reason),
				}),
			).finally(() => this.pending.delete(key));
			this.pending.set(key, p);
		}
		const granted = await p;
		if (granted) await this.d.grant(id, permission);
		return granted;
	}
}
