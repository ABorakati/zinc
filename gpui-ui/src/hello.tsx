import { createSignal } from "solid-js";

export function Hello() {
	const [count, setCount] = createSignal(0);
	return (
		<div style={{ padding: 24, backgroundColor: "#1a1a1a", height: "100%", gap: 12 }}>
			<text style={{ color: "#e2e2e2", fontSize: 18 }}>zotero-next on GPUI</text>
			<div onClick={() => setCount((v) => v + 1)} style={{ padding: 12, borderRadius: 8, backgroundColor: "#232323", hover: { backgroundColor: "#2c2c2c" } }}>
				<text style={{ color: "#e2e2e2" }}>Count: {count()}</text>
			</div>
		</div>
	);
}
