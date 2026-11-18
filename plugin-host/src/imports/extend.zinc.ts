// `zinc:plugin/extend` in the Zinc process. The implementation lives with the UI it drives:
// gpui-ui/src/wasmplugins/extend/handler.ts (registrations go into extend/registry.ts, which the main window renders).
// (The file name ends in .zinc.ts so `discoverHandlers("zinc")` finds it; the brief called it extend.ts.)
export { extendHandler as default } from "../../../gpui-ui/src/wasmplugins/extend/handler";
