using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ZoteroNext.Word
{
    /// <summary>
    /// Runs the agent tools (the TypeScript agent API, sidebar\agent-main.ts) for the MCP server. A hidden WebView2 in a window
    /// parked off-screen loads sidebar\agent.html lazily on the first call; the page talks to Word through its own Bridge, so
    /// its document target and undo records never mix with the sidebar's. Every member must be used on Word's UI thread
    /// (the thread that creates the form); WebView2 callbacks arrive there too.
    ///
    /// Protocol with the page: we post {event:"agentCall", data:{id, tool, args}}; the page replies with the bridge call
    /// "agent.result" {id, ok, json | error}, and announces itself with "agent.ready". Everything else the page sends is an
    /// ordinary bridge request (lib.*, style.*, doc.*), handled exactly as for the sidebar.
    /// </summary>
    internal sealed class AgentHost : IDisposable
    {
        sealed class AgentForm : Form
        {
            public AgentForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Location = new System.Drawing.Point(-32000, -32000);
                Size = new System.Drawing.Size(400, 300);
            }
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle |= 0x80 | 0x08000000;   // WS_EX_TOOLWINDOW (no Alt-Tab entry) | WS_EX_NOACTIVATE
                    return cp;
                }
            }
        }

        readonly Bridge _bridge;
        AgentForm _form;
        WebView2 _web;
        TaskCompletionSource<bool> _ready;
        Task _init;
        readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> _pending = new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
        int _seq;

        /// <summary>bridge: a Bridge of its own (not the sidebar's), e.g. new Bridge(shared.Doc.Clone()).</summary>
        public AgentHost(Bridge bridge) { _bridge = bridge; }

        async Task StartAsync()
        {
            var ready = new TaskCompletionSource<bool>();
            _ready = ready;
            var form = new AgentForm();
            var web = new WebView2 { Dock = DockStyle.Fill };
            form.Controls.Add(web);
            _form = form; _web = web;
            form.Show();   // creates the window handle (off-screen, not activated); WebView2 needs one
            var site = WebHost.SiteDir();
            var env = await WebHost.EnvAsync(web);
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("zn-sidebar.local", site, CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += OnMessage;
            core.NewWindowRequested += (s, e) => { e.Handled = true; };
            core.NavigationStarting += (s, e) => { if (!PaneControl.IsSidebarUri(e.Uri)) e.Cancel = true; };
            core.NavigationCompleted += (s, e) =>
            {
                if (!e.IsSuccess || e.HttpStatusCode >= 400)
                    ready.TrySetException(new InvalidOperationException("The agent page could not be loaded from " + site + " (agent.html: " + (e.IsSuccess ? "HTTP " + e.HttpStatusCode : e.WebErrorStatus.ToString()) + "). Rebuild the add-in's sidebar (bun build.ts)."));
            };
            web.Source = new Uri("https://zn-sidebar.local/agent.html");
            await ready.Task;
            Log.Write("agent page ready, site " + site);
        }

        async Task EnsureAsync(int timeoutMs)
        {
            if (_init == null) _init = StartAsync();
            var t = _init;
            var winner = await Task.WhenAny(t, Task.Delay(timeoutMs));
            if (winner != t)
            {
                Recycle();
                throw new TimeoutException("The agent page did not start within " + (timeoutMs / 1000) + " s (is the WebView2 runtime installed, and sidebar\\agent.html built?).");
            }
            try { await t; }
            catch { Recycle(); throw; }
        }

        /// <summary>Run one tool. Returns the page's answer {id, ok, json | error}; throws on timeout or when the page cannot run.</summary>
        public async Task<Dictionary<string, object>> CallAsync(string tool, Dictionary<string, object> args, int timeoutMs)
        {
            await EnsureAsync(30000);
            var tcs = new TaskCompletionSource<Dictionary<string, object>>();
            int id = ++_seq;
            _pending[id] = tcs;
            Post(Json.Dump(Json.Map("event", "agentCall", "data", Json.Map("id", id, "tool", tool, "args", args ?? new Dictionary<string, object>()))));
            using (var cts = new CancellationTokenSource())
            {
                var winner = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs, cts.Token));
                if (winner != tcs.Task)
                {
                    _pending.Remove(id);
                    // the page may be stuck mid-edit: drop it (a fresh one loads on the next call) and close any open undo record
                    Recycle();
                    throw new TimeoutException("The tool '" + tool + "' did not finish within " + (timeoutMs / 1000) + " s. The document may be partly changed; one Undo in Word reverts it.");
                }
                cts.Cancel();
            }
            return await tcs.Task;
        }

        void Post(string json)
        {
            var form = _form;
            if (form == null || form.IsDisposed) return;
            if (form.InvokeRequired) { try { form.BeginInvoke((Action)(() => Post(json))); } catch { } return; }
            try { _web.CoreWebView2.PostWebMessageAsString(json); } catch (Exception e) { Log.Error("agent post failed", e); }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!PaneControl.IsSidebarUri(e.Source)) return;
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (string.IsNullOrEmpty(msg)) return;
            Dictionary<string, object> req;
            try { req = Json.Obj(Json.Parse(msg)); } catch { return; }
            if (req == null) return;
            string method = Json.Str(req, "method");
            object rid = Json.Get(req, "id");
            if (method == "agent.ready")
            {
                if (_ready != null) _ready.TrySetResult(true);
                Post(Json.Dump(Json.Map("id", rid, "result", Json.Map("ok", true))));
                return;
            }
            if (method == "agent.result")
            {
                var pr = Json.Obj(Json.Get(req, "params")) ?? new Dictionary<string, object>();
                TaskCompletionSource<Dictionary<string, object>> tcs;
                int id = Json.Int(pr, "id", -1);
                if (_pending.TryGetValue(id, out tcs)) { _pending.Remove(id); tcs.TrySetResult(pr); }
                Post(Json.Dump(Json.Map("id", rid, "result", Json.Map("ok", true))));
                return;
            }
            if (Bridge.NeedsWordThread(method)) Post(_bridge.HandleJson(msg));   // already on Word's thread
            else Task.Run(() => _bridge.HandleJson(msg)).ContinueWith(t => Post(t.Result), TaskContinuationOptions.OnlyOnRanToCompletion);
        }

        /// <summary>Throw the page away (timeout, or shutdown). A new one is created by the next call.</summary>
        void Recycle()
        {
            try { _bridge.Doc.ResetBatch(); } catch { }
            var pend = _pending.Values.ToArray();
            _pending.Clear();
            foreach (var p in pend) p.TrySetException(new InvalidOperationException("The agent page was reset."));
            var form = _form;
            _form = null; _web = null; _ready = null; _init = null;
            try { if (form != null && !form.IsDisposed) { form.Close(); form.Dispose(); } } catch { }
        }

        public void Dispose() { Recycle(); }
    }
}
