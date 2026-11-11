// The Objective-C runtime through bun:ffi, for the few AppKit / PDFKit calls the app makes itself on macOS (webview/cocoa.ts,
// reader/printMac.ts). Lazy: nothing is loaded off macOS.
//
// objc_msgSend has no fixed signature: each shape used here is linked separately from the one function pointer. GPUIX ships an Apple
// Silicon build only, and on arm64 an NSRect argument (four doubles, a homogeneous float aggregate) travels in d0-d3, exactly like
// four separate double arguments, so `rect` calls pass x, y, width, height. Methods that RETURN a struct are not used (bun:ffi cannot
// receive one).
import { dlopen, FFIType, linkSymbols, read } from "bun:ffi";

const { ptr: P, i32: I32, i64: I64, u64: U64, f64: F64, bool: B } = FFIType;
export type Id = number | bigint | null;

interface Send {
	/** [o sel] -> id (also NSUInteger results) */
	m0(o: Id, s: Id): Id;
	/** [o sel:a] -> id */
	m1(o: Id, s: Id, a: Id): Id;
	/** [o sel:a b:b] -> id */
	m2(o: Id, s: Id, a: Id, b: Id): Id;
	/** [o sel:(NSUInteger)n] -> id */
	mu(o: Id, s: Id, n: number | bigint): Id;
	/** [o sel:(BOOL / int)n] -> id */
	mi(o: Id, s: Id, n: number): Id;
	/** [o sel:(NSRect){x, y, w, h}] -> id */
	mrect(o: Id, s: Id, x: number, y: number, w: number, h: number): Id;
	/** [o sel:a i:(NSInteger)n b:b] -> id (addSubview:positioned:relativeTo:) */
	mpip(o: Id, s: Id, a: Id, n: number | bigint, b: Id): Id;
	/** [o sel:a i:(NSInteger)n i:(BOOL)m] -> id (printOperationForPrintInfo:scalingMode:autoRotate:) */
	mpii(o: Id, s: Id, a: Id, n: number | bigint, m: number): Id;
	/** [o sel] -> BOOL */
	b0(o: Id, s: Id): boolean;
	/** [o sel:a] -> BOOL */
	b1(o: Id, s: Id, a: Id): boolean;
}

let rt: { send: Send; cls(n: string): Id; sel(n: string): Id; sym(n: string): Id; load(path: string): boolean } | null | undefined;

const cs = (s: string) => Buffer.from(`${s}\0`);

export function objc() {
	if (rt !== undefined) return rt;
	if (process.platform !== "darwin") return (rt = null);
	try {
		const sys = dlopen("/usr/lib/libSystem.B.dylib", {
			dlsym: { args: [I64, P], returns: P },
			dlopen: { args: [P, I32], returns: P },
		}).symbols;
		const lib = dlopen("/usr/lib/libobjc.A.dylib", {
			objc_getClass: { args: [P], returns: P },
			sel_registerName: { args: [P], returns: P },
		}).symbols;
		const RTLD_DEFAULT = -2n;
		const ptr = sys.dlsym(RTLD_DEFAULT, cs("objc_msgSend"));
		if (!ptr) return (rt = null);
		const send = linkSymbols({
			m0: { ptr, args: [P, P], returns: P },
			m1: { ptr, args: [P, P, P], returns: P },
			m2: { ptr, args: [P, P, P, P], returns: P },
			mu: { ptr, args: [P, P, U64], returns: P },
			mi: { ptr, args: [P, P, I32], returns: P },
			mrect: { ptr, args: [P, P, F64, F64, F64, F64], returns: P },
			mpip: { ptr, args: [P, P, P, I64, P], returns: P },
			mpii: { ptr, args: [P, P, P, I64, I32], returns: P },
			b0: { ptr, args: [P, P], returns: B },
			b1: { ptr, args: [P, P, P], returns: B },
		}).symbols as unknown as Send;
		const sels = new Map<string, Id>();
		const classes = new Map<string, Id>();
		rt = {
			send,
			cls: (n) => { let c = classes.get(n); if (c === undefined) classes.set(n, (c = lib.objc_getClass(cs(n)) as Id)); return c; },
			sel: (n) => { let s = sels.get(n); if (s === undefined) sels.set(n, (s = lib.sel_registerName(cs(n)) as Id)); return s; },
			/** the value of a global object constant (an NSString * variable such as NSPrintJobDisposition) */
			sym: (n) => { const a = sys.dlsym(RTLD_DEFAULT, cs(n)); return a ? (read.ptr(a as never) as Id) : null; },
			/** load a framework (its classes register with the runtime) */
			load: (path) => !!sys.dlopen(cs(path), 2 /* RTLD_NOW */),
		};
	} catch {
		rt = null;
	}
	return rt;
}

/** An autoreleased NSString for `s`. */
export function nsString(s: string): Id {
	const r = objc();
	if (!r) return null;
	return r.send.m1(r.cls("NSString"), r.sel("stringWithUTF8String:"), cs(s) as unknown as Id);
}
