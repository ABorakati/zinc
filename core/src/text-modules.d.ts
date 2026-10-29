// Files imported with `with { type: "text" }` (Bun embeds their contents).
declare module "*.sql" {
	const text: string;
	export default text;
}
