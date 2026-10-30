// JSON calls for settings that live on the server, plus a hook list so state can be refreshed when the page is shown.
export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* keep status text */ }
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

const openHooks: (() => void)[] = [];
/** Run `fn` each time the Settings tab is opened or focused (and once at start). */
export const onSettingsShown = (fn: () => void) => { openHooks.push(fn); };
export const settingsShown = () => openHooks.forEach((f) => f());
