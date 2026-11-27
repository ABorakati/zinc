// Run in a child process by appearance.mac.test.ts: onMacThemeChange's callback runs on AppleInterfaceThemeChangedNotification.
// This needs the main run loop, which this script runs with CFRunLoopRunInMode (GPUIX's tick() runs it in the app). In the test
// process, running it would also run whatever GPUI work earlier test files left queued on the main thread: after
// src/ui/menu.test.tsx, the close of a test window whose app is gone, which makes GPUI panic and abort Bun.
import { dlopen, FFIType } from "bun:ffi";
import { onMacThemeChange } from "../appearance";

const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
	CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
	CFNotificationCenterGetDistributedCenter: { args: [], returns: FFIType.u64 },
	CFNotificationCenterPostNotification: {
		args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.bool],
		returns: FFIType.void,
	},
	CFRunLoopRunInMode: { args: [FFIType.u64, FFIType.f64, FFIType.bool], returns: FFIType.i32 },
}).symbols;
const str = (s: string) => cf.CFStringCreateWithCString(null, Buffer.from(`${s}\0`, "utf8"), 0x08000100) as bigint;
const mode = str("kCFRunLoopDefaultMode");

let calls = 0;
if (!onMacThemeChange(() => calls++)) {
	console.log("onMacThemeChange returned false");
	process.exit(1);
}
cf.CFNotificationCenterPostNotification(
	cf.CFNotificationCenterGetDistributedCenter() as bigint,
	str("AppleInterfaceThemeChangedNotification"),
	0n,
	0n,
	true,
);
for (let i = 0; i < 50 && calls === 0; i++) {
	cf.CFRunLoopRunInMode(mode, 0.05, false);
	await Bun.sleep(10);
}
console.log(calls > 0 ? "OK" : "no callback");
process.exit(calls > 0 ? 0 : 1);
