import { render } from "solid-js/web";
import { App } from "./App";
import "./styles.css";
import { startTheme } from "./settings/appearance";

startTheme();
render(() => <App />, document.getElementById("root")!);
