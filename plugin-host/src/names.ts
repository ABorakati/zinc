// Name helpers. WIT names are kebab-case; jco's JS names are camelCase. The plugin API accepts both everywhere.

/** "set-timeout" -> "setTimeout". Already-camel input is returned unchanged. */
export function camel(name: string): string {
	return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** "setTimeout" -> "set-timeout". */
export function kebab(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** "zinc:plugin/prefs@0.1.0" -> "zinc:plugin/prefs"; "prefs" -> "zinc:plugin/prefs"; "wasi:cli/stdout@0.2.12" -> "wasi:cli/stdout". */
export function ifaceName(name: string): string {
	const base = name.replace(/@[^@]*$/, "");
	return base.includes(":") ? base : `zinc:plugin/${base}`;
}

/** "zinc:plugin/extend-handlers@0.1.0" -> "extend-handlers". */
export function shortIface(name: string): string {
	return ifaceName(name).replace(/^zinc:plugin\//, "");
}
