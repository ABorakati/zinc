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
                    if (mine.Count != 1) { try { _app.Quit(0); } catch { } throw new InvalidOperationException("could not identify the Word process this harness started"); }
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
            case "h.comSelfTest": return ComSelfTest();
            case "h.pane":
                {
                    // The real sidebar control (WebView2 + bundled page + bridge) in an off-screen, never-activated window.
                    if (_form == null)
                    {
                        Connect.Shared = _bridge;
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
