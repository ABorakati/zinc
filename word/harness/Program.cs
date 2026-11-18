using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Xml;
using ZoteroNext.Word;

// Line protocol: one JSON request per stdin line -> one JSON response per stdout line.
//   {"id":1,"method":"h.start"}                       start a private invisible Word (refuses if any WINWORD.EXE already runs)
//   {"id":2,"method":"h.newDoc"} / h.open {path} / h.saveAs {path} / h.close / h.quit
//   {"id":3,"method":"h.type","params":{"text":"..."}}   type at the cursor;  h.cursorEnd;  h.text
//   anything else goes to the add-in Bridge (lib.*, style.*, doc.*), exactly what the sidebar sends.
// The user's own Word is never touched: with one running, h.start fails before creating anything.
internal static class Program
{
    static dynamic _app;
    static int _pid;
    static Bridge _bridge;
    static System.Windows.Forms.Form _form;
    static PaneControl _paneCtl;
    static System.Windows.Forms.Control _inv;
    static McpServer _mcp;

    /// <summary>A borderless window parked far off-screen, no taskbar button, never activated.</summary>
    sealed class OffscreenForm : System.Windows.Forms.Form
    {
        public OffscreenForm()
        {
            FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = System.Windows.Forms.FormStartPosition.Manual;
            Location = new System.Drawing.Point(-32000, -32000);
            Size = new System.Drawing.Size(420, 800);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
    }

    [STAThread]
    static int Main(string[] args)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--db") Environment.SetEnvironmentVariable("ZN_DB", args[i + 1]);
            if (args[i] == "--settings") Settings.OverrideFile = args[i + 1];
            if (args[i] == "--cache") Settings.CacheDir = args[i + 1];
        }
        int port = 0;
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--port") port = int.Parse(args[i + 1]);
        if (port == 0) throw new ArgumentException("--port N is required (loopback TCP, one client, newline-delimited JSON)");
        // Like Word's own UI thread, the STA thread that owns the Word object pumps messages (a blocking read
        // here deadlocks COM callbacks from Word). Requests are read on a worker thread and run on this one.
        var inv = new System.Windows.Forms.Control();
        var handle = inv.Handle;
        _inv = inv;
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
        listener.Start();
        var reader = new Thread(() =>
        {
            using (var client = listener.AcceptTcpClient())
            {
                var ns = client.GetStream();
                var stdin = new StreamReader(ns, new UTF8Encoding(false));
                var stdout = new StreamWriter(ns, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    string l = line; bool stop = false;
                    inv.Invoke((Action)(() => { stop = HandleLine(l, stdout); }));
                    if (stop) break;
                }
            }
            inv.Invoke((Action)(() => { Cleanup(); System.Windows.Forms.Application.ExitThread(); }));
        }) { IsBackground = true };
        reader.Start();
        System.Windows.Forms.Application.Run();
        return 0;
    }

    static bool HandleLine(string line, StreamWriter stdout)
    {
        if (Environment.GetEnvironmentVariable("ZN_HARNESS_TRACE") == "1") Console.Error.WriteLine("> " + (line.Length > 140 ? line.Substring(0, 140) : line));
        string resp;
        object id = null;
        try
        {
            var req = Json.Obj(Json.Parse(line));
            id = Json.Get(req, "id");
            string method = Json.Str(req, "method");
            var p = Json.Obj(Json.Get(req, "params")) ?? new Dictionary<string, object>();
            object result = method.StartsWith("h.") ? Harness(method, p) : Bridge_(line);
            if (method.StartsWith("h.")) resp = Json.Dump(Json.Map("id", id, "result", result));
            else resp = (string)result;
        }
        catch (Exception e)
        {
            var inner = e; while (inner.InnerException != null) inner = inner.InnerException;
            resp = Json.Dump(Json.Map("id", id, "error", Json.Map("message", inner.Message)));
        }
        stdout.WriteLine(resp);
        if (Environment.GetEnvironmentVariable("ZN_HARNESS_TRACE") == "1") Console.Error.WriteLine("< " + (resp.Length > 100 ? resp.Substring(0, 100) : resp));
        return _quit;
    }

    static bool _quit;

    static string Bridge_(string line)
    {
        if (_bridge == null) throw new InvalidOperationException("call h.start first");
        return _bridge.HandleJson(line);
    }

    static object Harness(string method, Dictionary<string, object> p)
    {
        switch (method)
        {
            case "h.start":
                {
                    if (Process.GetProcessesByName("WINWORD").Length > 0 && Environment.GetEnvironmentVariable("ZN_HARNESS_ALLOW_OTHER_WORD") != "1")
                        throw new InvalidOperationException("Word is already running (the user's?). Refusing to start: this harness never attaches to or touches an existing Word.");
                    var before = new HashSet<int>(Process.GetProcessesByName("WINWORD").Select(x => x.Id));
                    var t = Type.GetTypeFromProgID("Word.Application");
                    _app = Activator.CreateInstance(t);
                    Thread.Sleep(300);
                    var mine = Process.GetProcessesByName("WINWORD").Select(x => x.Id).Where(x => !before.Contains(x)).ToList();
                    // Not provably our own Word (no new process, or a fresh one that already has documents: COM attached to
                    // someone else's): let go of it WITHOUT Quit, which would close that Word and its unsaved work.
                    bool fresh = false;
                    if (mine.Count == 1) { try { fresh = (int)_app.Documents.Count == 0; } catch { } }
                    if (!fresh) { try { Marshal.ReleaseComObject((object)_app); } catch { } _app = null; throw new InvalidOperationException("could not identify the Word process this harness started"); }
                    _pid = mine[0];
                    _app.Visible = false;
                    _app.DisplayAlerts = 0;
                    _bridge = new Bridge(new WordDoc((object)_app));
                    return Json.Map("pid", _pid, "version", (string)_app.Version);
                }
            case "h.newDoc": _app.Documents.Add(); return Json.Map("ok", true);
            case "h.open": _app.Documents.Open(Json.Str(p, "path")); return Json.Map("ok", true);
            case "h.saveAs": _app.ActiveDocument.SaveAs2(Json.Str(p, "path"), 16); return Json.Map("ok", true);
            case "h.close": _app.ActiveDocument.Close(0); return Json.Map("ok", true);
            case "h.text": { dynamic r = _app.ActiveDocument.Content; r.TextRetrievalMode.IncludeFieldCodes = false; return Json.Map("text", (string)r.Text); }
            case "h.type": _app.Selection.TypeText(Json.Str(p, "text")); return Json.Map("ok", true);
            case "h.para": _app.Selection.TypeParagraph(); return Json.Map("ok", true);
            case "h.cursorEnd": _app.Selection.EndKey(6); return Json.Map("ok", true);
            case "h.cursor": { int s = Json.Int(p, "start"); int e = p.ContainsKey("end") ? Json.Int(p, "end") : s; _app.Selection.SetRange(s, e); return Json.Map("ok", true); }
            case "h.find":
                {
                    // position of text in the main story (for placing the cursor in tests)
                    string text = (string)_app.ActiveDocument.Content.Text;
                    return Json.Map("pos", text.IndexOf(Json.Str(p, "text"), StringComparison.Ordinal));
                }
            case "h.footnotes": return Json.Map("count", (int)_app.ActiveDocument.Footnotes.Count);
            case "h.fnText": return Json.Map("text", (string)_app.ActiveDocument.Footnotes.Item(Json.Int(p, "n")).Range.Text);
            case "h.fontOf":
                {
                    // formatting probe: italic/superscript flags of a range
                    dynamic r = _app.ActiveDocument.Range(Json.Int(p, "start"), Json.Int(p, "end"));
                    return Json.Map("italic", (int)r.Font.Italic, "sup", (int)r.Font.Superscript, "bold", (int)r.Font.Bold, "text", (string)r.Text);
                }
            case "h.undo": return Json.Map("ok", (bool)_app.ActiveDocument.Undo(Json.Int(p, "times", 1)));
            case "h.fieldCount": return Json.Map("count", (int)_app.ActiveDocument.Fields.Count);
            // ---- Track Changes probes
            case "h.track":
                {
                    if (p.ContainsKey("on")) _app.ActiveDocument.TrackRevisions = Json.Bool(p, "on");
                    if (p.ContainsKey("author")) _app.UserName = Json.Str(p, "author");
                    return Json.Map("on", (bool)_app.ActiveDocument.TrackRevisions);
                }
            case "h.revisions":
                {
                    // every revision in the main story: type 1 = insert, 2 = delete; text cut to 120 chars
                    var list = new List<object>();
                    dynamic revs = _app.ActiveDocument.Range().Revisions;
                    int n = (int)revs.Count;
                    for (int i = 1; i <= n; i++)
                    {
                        dynamic r = revs.Item(i);
                        string t = ""; try { t = (string)r.Range.Text ?? ""; } catch { }
                        list.Add(Json.Map("type", (int)r.Type, "text", t.Length > 120 ? t.Substring(0, 120) : t, "start", (int)r.Range.Start, "end", (int)r.Range.End));
                    }
                    return list;
                }
            case "h.rawSetCode":
                {
                    // write a field code the way the add-in did before the fix (no Track Changes handling), to make a damaged document
                    dynamic f = _app.ActiveDocument.Fields.Item(Json.Int(p, "idx"));
                    f.Code.Text = " " + Json.Str(p, "code").Trim() + " ";
                    return Json.Map("ok", true);
                }
            case "h.acceptAll": _app.ActiveDocument.Revisions.AcceptAll(); return Json.Map("ok", true);
            case "h.rejectAll": _app.ActiveDocument.Revisions.RejectAll(); return Json.Map("ok", true);
            case "h.fieldInfo":
                {
                    // what Word itself thinks of each field: code shown instead of the result?, revisions inside code / result
                    var list = new List<object>();
                    dynamic fs = _app.ActiveDocument.Fields;
                    int n = (int)fs.Count;
                    for (int i = 1; i <= n; i++)
                    {
                        dynamic f = fs.Item(i);
                        int rc = 0, rr = 0; string res = "";
                        try { rc = (int)f.Code.Revisions.Count; } catch { }
                        try { rr = (int)f.Result.Revisions.Count; res = (string)f.Result.Text ?? ""; } catch { }
                        string code = (string)f.Code.Text ?? "";
                        list.Add(Json.Map("idx", i, "showCodes", (bool)f.ShowCodes, "codeRevisions", rc, "resultRevisions", rr,
                            "code", code.Length > 200 ? code.Substring(0, 200) : code, "codeLength", code.Length, "result", res));
                    }
                    return list;
                }
            case "h.docXml": return Json.Map("xml", (string)_app.ActiveDocument.Content.WordOpenXML);
            case "h.pdf":
                {
                    // what a reader sees: PDF of the document, with markup (balloons, strike-through) when p.markup
                    // ExportAsFixedFormat(path, wdExportFormatPDF=17, OpenAfterExport, OptimizeFor, Range=wdExportAllDocument 0, From, To, Item: 0 content / 7 with markup)
                    if (Json.Bool(p, "balloons"))
                    {
                        // All Markup with revisions in balloons (deletions in the margin), as in Word's Review > Show Markup > Balloons
                        dynamic v = _app.ActiveDocument.ActiveWindow.View;
                        v.Type = 3;   // wdPrintView
                        try { v.RevisionsFilter.Markup = 2; v.RevisionsFilter.View = 0; } catch { }
                        v.MarkupMode = 0;   // wdBalloonRevisions
                    }
                    _app.ActiveDocument.ExportAsFixedFormat(Json.Str(p, "path"), 17, false, 0, 0, 1, 1, Json.Bool(p, "markup") ? 7 : 0);
                    return Json.Map("ok", true);
                }
            case "h.probe":
                {
                    // ms for each Word call the cursor watcher makes, at the current selection
                    var t = new Dictionary<string, object>();
                    var sw = new Stopwatch();
                    Func<string, Func<object>, object> time = (name, f) => { sw.Restart(); object v = null; for (int i = 0; i < 5; i++) v = f(); sw.Stop(); t[name] = Math.Round(sw.Elapsed.TotalMilliseconds / 5, 2); return v; };
                    dynamic d = _app.ActiveDocument; dynamic sel = _app.Selection;
                    int s = (int)sel.Start;
                    time("selection start/end/story", () => (int)sel.Start + (int)sel.End + (int)sel.StoryType);
                    time("doc FullName", () => (string)d.FullName);
                    dynamic story = d.Content;
                    time("story.Fields.Count", () => (int)story.Fields.Count);
                    dynamic sr = story.Duplicate; sr.SetRange(s, s);
                    time("Information(inFieldResult)", () => (bool)sr.Information(45));
                    time("Information(inFieldCode)", () => (bool)sr.Information(44));
                    dynamic before = story.Duplicate; before.SetRange((int)story.Start, s);
                    time("before.Fields.Count", () => (int)before.Fields.Count);
                    dynamic f1 = story.Fields.Item(Math.Max(1, (int)before.Fields.Count));
                    time("Fields.Item(i)", () => story.Fields.Item(Math.Max(1, (int)before.Fields.Count)));
                    time("field Code.Text", () => (string)f1.Code.Text);
                    time("field Result.Text", () => (string)f1.Result.Text);
                    time("field Code.Revisions.Count", () => (int)f1.Code.Revisions.Count);
                    time("story Revisions.Count", () => (int)story.Revisions.Count);
                    time("GetPoint(result)", () => { int l = 0, tp = 0, w = 0, hh = 0; _app.ActiveWindow.GetPoint(ref l, ref tp, ref w, ref hh, f1.Result); return l; });
                    time("full Cursor()", () => _bridge.Doc.Cursor());
                    return t;
                }
            case "h.watch":
                {
                    // the add-in's cursor watcher against this Word, as if a sidebar were shown: {on} starts it with zeroed counters
                    if (Json.Bool(p, "on"))
                    {
                        Connect.Shared = _bridge;
                        CursorWatch.RequireForeground = false;
                        CursorWatch.ForceWanted = true;
                        CursorWatch.WordTicks = 0; CursorWatch.FullReads = 0; CursorWatch.WordMs = 0;
                        CursorWatch.Start();
                    }
                    return Json.Map("wordTicks", CursorWatch.WordTicks, "fullReads", CursorWatch.FullReads, "wordMs", Math.Round(CursorWatch.WordMs, 1),
                        "inField", CursorWatch.Current != null && Json.Bool(CursorWatch.Current, "inField"));
                }
            case "h.legacyWatch":
                {
                    // the add-in's cursor polling BEFORE the CursorWatch rewrite, for a before/after measurement: the popup timer
                    // (250 ms: Cursor(), plus FieldRect when the cursor sits in a citation) and the sidebar timer (300 ms: Cursor()),
                    // run for `ms` while optionally typing a character every `typeEvery` ms. Returns the time spent in Word calls.
                    double wordMs = 0; int calls = 0;
                    var doc = _bridge.Doc;
                    var sw = new Stopwatch();
                    var popupT = new System.Windows.Forms.Timer { Interval = 250 };
                    var paneT = new System.Windows.Forms.Timer { Interval = 300 };
                    popupT.Tick += (s, e) =>
                    {
                        sw.Restart();
                        try
                        {
                            var c = LegacyCursor(); calls++;
                            if (Json.Bool(c, "inField") && Json.Int(c, "start") == Json.Int(c, "end")) doc.FieldRect(Json.Obj(Json.Get(c, "ref")));
                        }
                        catch { }
                        wordMs += sw.Elapsed.TotalMilliseconds;
                    };
                    paneT.Tick += (s, e) => { sw.Restart(); try { LegacyCursor(); calls++; } catch { } wordMs += sw.Elapsed.TotalMilliseconds; };
                    popupT.Start(); paneT.Start();
                    var until = DateTime.UtcNow.AddMilliseconds(Json.Int(p, "ms", 5000));
                    int every = Json.Int(p, "typeEvery", 0);
                    var next = DateTime.UtcNow;
                    while (DateTime.UtcNow < until)
                    {
                        if (every > 0 && DateTime.UtcNow >= next) { _app.Selection.TypeText("x"); next = DateTime.UtcNow.AddMilliseconds(every); }
                        System.Windows.Forms.Application.DoEvents(); Thread.Sleep(5);
                    }
                    popupT.Stop(); paneT.Stop(); popupT.Dispose(); paneT.Dispose();
                    return Json.Map("wordMs", Math.Round(wordMs, 1), "cursorCalls", calls);
                }
            case "h.benchCursorAB":
                {
                    // the old and the new cursor read, interleaved at the same selection: ms per call each
                    int n = Math.Max(1, Json.Int(p, "n", 10));
                    var sw = new Stopwatch(); double oldMs = 0, newMs = 0;
                    LegacyCursor(); _bridge.Doc.Cursor();
                    for (int i = 0; i < n; i++)
                    {
                        sw.Restart(); LegacyCursor(); oldMs += sw.Elapsed.TotalMilliseconds;
                        sw.Restart(); _bridge.Doc.Cursor(); newMs += sw.Elapsed.TotalMilliseconds;
                    }
                    return Json.Map("oldMs", Math.Round(oldMs / n, 1), "newMs", Math.Round(newMs / n, 1));
                }
            case "h.typeFor":
                {
                    // type one character every `every` ms for `ms` ms, letting timers run in between (a user typing)
                    var until = DateTime.UtcNow.AddMilliseconds(Json.Int(p, "ms", 3000));
                    int every = Json.Int(p, "every", 120);
                    var next = DateTime.UtcNow;
                    while (DateTime.UtcNow < until)
                    {
                        if (DateTime.UtcNow >= next) { _app.Selection.TypeText("x"); next = DateTime.UtcNow.AddMilliseconds(every); }
                        System.Windows.Forms.Application.DoEvents(); Thread.Sleep(5);
                    }
                    return Json.Map("ok", true);
                }
            case "h.bench":
                {
                    // time n calls of a bridge method in this process (no socket round trip): {method, params, n} -> ms per call
                    string m = Json.Str(p, "method");
                    var prm = Json.Obj(Json.Get(p, "params")) ?? new Dictionary<string, object>();
                    int n = Math.Max(1, Json.Int(p, "n", 20));
                    _bridge.Call(m, prm);   // warm-up
                    var sw = Stopwatch.StartNew();
                    for (int i = 0; i < n; i++) _bridge.Call(m, prm);
                    sw.Stop();
                    return Json.Map("ms", sw.Elapsed.TotalMilliseconds / n, "n", n);
                }
            case "h.comSelfTest": return ComSelfTest();
            case "h.pane":
                {
                    // The real sidebar control (WebView2 + bundled page + bridge) in an off-screen, never-activated window.
                    if (_form == null)
                    {
                        Connect.Shared = _bridge;
                        CursorWatch.RequireForeground = false;   // this private Word is never the foreground app
                        _form = new OffscreenForm();
                        _paneCtl = new PaneControl();
                        _form.Controls.Add(_paneCtl);
                        _form.Show();
                    }
                    var until = DateTime.UtcNow.AddSeconds(40);
                    while (!_paneCtl.Ready && DateTime.UtcNow < until) { System.Windows.Forms.Application.DoEvents(); Thread.Sleep(20); }
                    return Json.Map("ready", _paneCtl.Ready);
                }
            case "h.paneEval":
                {
                    var task = _paneCtl.Web.CoreWebView2.ExecuteScriptAsync(Json.Str(p, "js"));
                    var until = DateTime.UtcNow.AddSeconds(20);
                    while (!task.IsCompleted && DateTime.UtcNow < until) { System.Windows.Forms.Application.DoEvents(); Thread.Sleep(10); }
                    if (!task.IsCompleted) throw new TimeoutException("script did not finish");
                    return Json.Map("json", task.Result);
                }
            case "h.pump":
                {
                    // let timers (the cursor watcher) and WebView2 callbacks run
                    var until = DateTime.UtcNow.AddMilliseconds(Json.Int(p, "ms", 500));
                    while (DateTime.UtcNow < until) { System.Windows.Forms.Application.DoEvents(); Thread.Sleep(10); }
                    return Json.Map("ok", true);
                }
            case "h.mcp":
                {
                    // The MCP server on 127.0.0.1:port against this Word. Without h.start first (noWord) only the tools that do not need a
                    // document work: search_library, search_styles. tokenFile: where the bearer token is kept (a test file, never the user's).
                    if (_mcp != null) { _mcp.Dispose(); _mcp = null; }
                    var bridge = _bridge ?? new Bridge(new WordDoc(null));
                    _mcp = McpServer.Start(_inv, bridge, Json.Int(p, "port", McpServer.DefaultPort), Json.Str(p, "tokenFile"));
                    return Json.Map("port", _mcp.Port);
                }
            case "h.mcpStop": if (_mcp != null) { _mcp.Dispose(); _mcp = null; } return Json.Map("ok", true);
            case "h.quit": Cleanup(); _quit = true; return Json.Map("ok", true);
            default: throw new ArgumentException("unknown harness method " + method);
        }
    }

    static void Cleanup()
    {
        try { if (_mcp != null) { _mcp.Dispose(); _mcp = null; } } catch { }
        try { if (_form != null) { _form.Close(); _form.Dispose(); _form = null; } } catch { }
        try
        {
            if (_app != null)
            {
                try { while ((int)_app.Documents.Count > 0) _app.Documents.Item(1).Close(0); } catch { }
                try { _app.Quit(0); } catch { }
                try { Marshal.ReleaseComObject((object)_app); } catch { }
                _app = null;
            }
        }
        catch { }
        if (_pid != 0)
        {
            // only the process this harness started, and only if Quit left it behind
            try { Thread.Sleep(1500); var pr = Process.GetProcessById(_pid); if (!pr.HasExited && pr.ProcessName.Equals("WINWORD", StringComparison.OrdinalIgnoreCase)) pr.Kill(); } catch { }
            _pid = 0;
        }
    }

    // ---- the cursor read as it was before the CursorWatch rewrite (copied verbatim from WordDoc.Cursor at 14addb3), for h.legacyWatch
    const int wdMainTextStory = 1, wdFootnotesStory = 2, wdInFieldCode = 44, wdInFieldResult = 45;
    static string LegacyKindOf(string code)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(code, @"^\s*ADDIN\s+ZOTERO_ITEM")) return "item";
        if (System.Text.RegularExpressions.Regex.IsMatch(code, @"^\s*ADDIN\s+ZOTERO_BIBL")) return "bibl";
        return null;
    }
    static Dictionary<string, object> LegacyCursor()
    {
        if ((int)_app.Documents.Count == 0) return Json.Map("hasDoc", false);
        dynamic d = _app.ActiveDocument;
        dynamic sel = _app.Selection;
        int st = (int)sel.StoryType, s = (int)sel.Start, e = (int)sel.End;
        var res = Json.Map("hasDoc", true, "doc", (string)d.FullName, "start", s, "end", e, "story", st, "inField", false);
        try
        {
            dynamic story = st == wdMainTextStory ? d.Content : sel.StoryRange;
            if ((int)story.Fields.Count == 0) return res;
            dynamic startRange = story.Duplicate; startRange.SetRange(s, s);
            bool inside = (bool)startRange.Information(wdInFieldResult) || (bool)startRange.Information(wdInFieldCode);
            int idx = -1;
            if (inside)
            {
                dynamic before = story.Duplicate; before.SetRange(story.Start, s);
                int guess = (int)before.Fields.Count + 1;
                int total = (int)story.Fields.Count;
                for (int i = Math.Max(1, guess - 1); i <= Math.Min(total, guess + 1); i++)
                {
                    dynamic f = story.Fields.Item(i);
                    int fs = (int)f.Code.Start - 1, fe = (int)f.Result.End + 1;
                    if (s >= fs && s <= fe && LegacyKindOf((string)f.Code.Text) != null) { idx = i; break; }
                }
            }
            else if (e > s)
            {
                // a selection covering whole fields (e.g. a double-clicked citation)
                dynamic r = story.Duplicate; r.SetRange(s, e);
                if ((int)r.Fields.Count > 0)
                {
                    dynamic before = story.Duplicate; before.SetRange(story.Start, s);
                    int guess = (int)before.Fields.Count + 1;
                    int total = (int)story.Fields.Count;
                    for (int i = guess; i <= Math.Min(total, guess + 3); i++)
                    {
                        dynamic f = story.Fields.Item(i);
                        if (LegacyKindOf((string)f.Code.Text) != null && (int)f.Code.Start - 1 >= s - 1 && (int)f.Result.End + 1 <= e + 1) { idx = i; break; }
                    }
                }
            }
            if (idx > 0)
            {
                dynamic f = story.Fields.Item(idx);
                string code = ((string)f.Code.Text).Trim();
                res["inField"] = true;
                res["ref"] = Json.Map("story", st == wdMainTextStory ? "main" : (st == wdFootnotesStory ? "fn" : "en"), "idx", idx);
                res["kind"] = LegacyKindOf(code);
                res["code"] = code;
                res["text"] = (string)f.Result.Text;
            }
        }
        catch (Exception ex) { res["error"] = ex.Message; }
        return res;
    }

    // ---- checks of the COM surface that do not need Word to load the add-in ----------------------------------------
    [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, int ctx, ref Guid iid, out IntPtr obj);

    static object ComSelfTest()
    {
        var res = new Dictionary<string, object>();
        var asm = typeof(Connect).Assembly;
        var connect = new Connect();
        IntPtr unk = Marshal.GetIUnknownForObject(connect);
        try
        {
            foreach (var iid in new[] { "B65AD801-ABAF-11D0-BB8B-00A0C90F2744", "000C0396-0000-0000-C000-000000000046", "000C033E-0000-0000-C000-000000000046" })
            {
                var g = new Guid(iid); IntPtr p;
                int hr = Marshal.QueryInterface(unk, ref g, out p);
                res["qi " + iid] = hr == 0;
                if (p != IntPtr.Zero) Marshal.Release(p);
            }
        }
        finally { Marshal.Release(unk); }
        res["connect.guid"] = typeof(Connect).GUID.ToString().ToUpper();
        res["connect.progid"] = ((ProgIdAttribute)Attribute.GetCustomAttribute(typeof(Connect), typeof(ProgIdAttribute))).Value;
        res["pane.guid"] = typeof(PaneControl).GUID.ToString().ToUpper();
        res["pane.progid"] = ((ProgIdAttribute)Attribute.GetCustomAttribute(typeof(PaneControl), typeof(ProgIdAttribute))).Value;
        res["pane.isControl"] = typeof(System.Windows.Forms.UserControl).IsAssignableFrom(typeof(PaneControl));
        res["pane.ctor"] = typeof(PaneControl).GetConstructor(Type.EmptyTypes) != null;
        // ribbon xml is well formed and every callback exists on Connect
        var doc = new XmlDocument(); doc.LoadXml(Connect.RibbonXml);
        var missing = new List<string>();
        foreach (XmlNode n in doc.SelectNodes("//*[@onAction]"))
        {
            var name = n.Attributes["onAction"].Value;
            if (typeof(Connect).GetMethod(name) == null) missing.Add(name);
        }
        res["ribbon.ok"] = true; res["ribbon.missingCallbacks"] = missing;
        // every public COM-visible type has a GUID; assembly default is not visible
        res["public.types"] = asm.GetExportedTypes().Select(t => t.Name).Where(n => n == "Connect" || n == "PaneControl").OrderBy(x => x).ToList();
        return res;
    }
}
