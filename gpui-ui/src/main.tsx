import { render } from "@gpuix/solid";
import { App } from "./App";
import { registerFonts } from "./fonts";

registerFonts();
render(() => <App />, { title: "zotero-next", width: 1400, height: 900 });
