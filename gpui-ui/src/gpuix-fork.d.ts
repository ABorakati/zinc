// Typings for what the local GPUIX fork (~/src/gpuix, branch zn-cache) adds to the npm @gpuix 0.11 packages. The JS layer
// forwards these props unchanged (custom props are generic), so only the types are missing until the fork's js/host.ts and index.d.ts are published.
import "@gpuix/native/host";

declare module "@gpuix/native/host" {
	interface GpuixTheme {
		/** <markdown> link text and underline colour (unset: links keep the text colour) */
		link?: string;
	}
	interface MarkdownProps {
		/** links under the pointer fire onMouseEnter / onMouseLeave with value = URL and x/y/width/height = the link's line box */
		linkHover?: boolean;
		/** highlights / underlines over [start, end) UTF-16 ranges of `source` */
		marks?: { start: number; end: number; color?: string; kind?: "highlight" | "underline" }[];
	}
}
