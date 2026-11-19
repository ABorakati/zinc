# Runs INSIDE soffice (the harness copies it into the private test profile's user/Scripts/python and calls it through the
# script provider), to time the extension's document code in-process, as the installed extension runs it. The harness's own
# calls cross a process boundary per UNO call, so its timings overstate the real cost many times over.
import json
import sys
import time


def bench(uid, pythonpath, method, params, n):
    if pythonpath not in sys.path:
        sys.path.insert(0, pythonpath)
    from zinc_lo.lodoc import LoDoc

    ctx = XSCRIPTCONTEXT.getComponentContext()  # noqa: F821 (provided by LibreOffice's script framework)
    desktop = XSCRIPTCONTEXT.getDesktop()  # noqa: F821
    doc = None
    e = desktop.getComponents().createEnumeration()
    while e.hasMoreElements():
        c = e.nextElement()
        try:
            if c.RuntimeUID == uid:
                doc = c
                break
        except Exception:
            pass
    if doc is None:
        return json.dumps({"error": "document not found"})
    ld = LoDoc(ctx, lambda: doc, desktop)
    n = max(1, int(n))
    p = json.loads(params or "{}")
    if method == "rewriteAll":
        # what a refresh that changes every citation costs on the document side: one read, one batched write of all
        fields = ld.fields()
        items = [{"ref": {"story": f["story"], "idx": f["idx"], "kind": f["kind"]}, "code": f["code"], "runs": [{"t": "(%d)" % (i + 1), "i": 1}]} for i, f in enumerate(fields)]
        t = time.perf_counter()
        ld.call("doc.begin", {"name": "bench"})
        ld.call("doc.fields", {})
        ld.call("doc.setMany", {"items": items})
        ld.call("doc.end", {})
        return json.dumps({"ms": (time.perf_counter() - t) * 1000, "n": len(items)})
    ld.call(method, p)
    t = time.perf_counter()
    for _ in range(n):
        ld.call(method, p)
    return json.dumps({"ms": (time.perf_counter() - t) * 1000 / n, "n": n})


g_exportedScripts = (bench,)
