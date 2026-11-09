using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ZoteroNext.Word
{
    /// <summary>
    /// A minimal MCP server (Streamable HTTP, JSON responses only) so AI agents can manage Zotero citations in the document open in
    /// Word. POST /mcp takes JSON-RPC 2.0 (initialize, notifications/initialized, ping, tools/list, tools/call); GET /mcp answers 405.
    /// It runs on its own TcpListener on 127.0.0.1 with a small HTTP/1.1 parser (HttpListener needs URL ACLs from http.sys).
    ///
    /// Security: every request needs "Authorization: Bearer &lt;token&gt;" (a random token kept once in
    /// %APPDATA%\zotero-next-word\mcp-token, readable by the user only; never logged); a request with a non-empty Origin header is
    /// refused (browsers send it; this stops DNS-rebinding pages); the Host header must name the loopback address.
    ///
    /// Tools are defined in McpTools.json (embedded) and executed by the TypeScript agent API through <see cref="AgentHost"/> on Word's
    /// UI thread. Calls run one at a time. The tool list and input schemas are the single source for both sides.
    /// </summary>
    internal sealed class McpServer : IDisposable
    {
        public const int DefaultPort = 23125;
        const int MaxHeaderBytes = 32 * 1024, MaxBodyBytes = 8 * 1024 * 1024, MaxConnections = 32;
        static readonly string[] SupportedVersions = { "2025-06-18", "2025-03-26", "2024-11-05" };

        readonly Control _ui;
        readonly AgentHost _agent;
        readonly string _token;
        readonly TcpListener _listener;
        readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
        readonly List<TcpClient> _clients = new List<TcpClient>();
        volatile bool _stopped;

        public int Port { get; private set; }

        // ---------------------------------------------------------------- tool definitions (McpTools.json)

        static readonly Lazy<Dictionary<string, object>> Spec = new Lazy<Dictionary<string, object>>(() =>
        {
            using (var s = typeof(McpServer).Assembly.GetManifestResourceStream("McpTools.json"))
            {
                if (s == null) throw new InvalidOperationException("McpTools.json is not embedded in the add-in.");
                using (var r = new StreamReader(s, new UTF8Encoding(false))) return Json.Obj(Json.Parse(r.ReadToEnd()));
            }
        });

        static List<object> ToolList() { return Json.Arr(Json.Get(Spec.Value, "tools")).ToList(); }
        static bool IsTool(string name) { return ToolList().Any(t => Json.Str(Json.Obj(t), "name") == name); }

        // ---------------------------------------------------------------- settings and token

        public static string DefaultTokenFile() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "zotero-next-word", "mcp-token"); }

        /// <summary>Setting mcpEnabled (default on).</summary>
        public static bool EnabledBySetting()
        {
            var v = Json.Get(Settings.Load(), "mcpEnabled");
            if (v is bool) return (bool)v;
            var s = v as string;
            if (s == null) return true;
            return !(s.Equals("false", StringComparison.OrdinalIgnoreCase) || s == "0" || s.Equals("off", StringComparison.OrdinalIgnoreCase) || s.Equals("no", StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Setting mcpPort (default 23125).</summary>
        public static int PortFromSetting()
        {
            int p = Json.Int(Settings.Load(), "mcpPort", DefaultPort);
            return p > 0 && p < 65536 ? p : DefaultPort;
        }

        static int TimeoutMs() { return Math.Max(5000, Math.Min(600000, Json.Int(Settings.Load(), "mcpTimeoutMs", 120000))); }

        /// <summary>The token in the file, created (random, user-only access) when there is none yet.</summary>
        public static string LoadOrCreateToken(string file)
        {
            try
            {
                if (File.Exists(file))
                {
                    var t = File.ReadAllText(file).Trim();
                    if (t.Length >= 32) { Restrict(file); return t; }
                }
            }
            catch { }
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var token = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            var sec = new FileSecurity();
            sec.SetAccessRuleProtection(true, false);
            sec.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
            using (var fs = new FileStream(file, FileMode.Create, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.None, sec))
            {
                var b = Encoding.ASCII.GetBytes(token);
                fs.Write(b, 0, b.Length);
            }
            return token;
        }

        /// <summary>Only the current user may read or write the token file.</summary>
        static void Restrict(string file)
        {
            try
            {
                var me = WindowsIdentity.GetCurrent().User;
                var info = new FileInfo(file);
                var sec = info.GetAccessControl();
                sec.SetAccessRuleProtection(true, false);
                foreach (FileSystemAccessRule r in sec.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                    if (!r.IdentityReference.Equals(me)) sec.RemoveAccessRuleSpecific(r);
                sec.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, AccessControlType.Allow));
                info.SetAccessControl(sec);
            }
            catch (Exception e) { Log.Error("mcp token permissions", e); }
        }

        // ---------------------------------------------------------------- lifetime

        McpServer(Control ui, AgentHost agent, string token, int port)
        {
            _ui = ui; _agent = agent; _token = token;
            _listener = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };
        }

        /// <summary>
        /// Start serving. ui: a control created on Word's UI thread (tool calls are marshalled to it). shared: the add-in's Bridge (the agent gets
        /// a Bridge of its own over the same Word). Throws when the port is taken.
        /// </summary>
        public static McpServer Start(Control ui, Bridge shared, int port, string tokenFile)
        {
            try { if (SynchronizationContext.Current == null) SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext()); } catch { }
            var _ = ui.Handle;   // make sure the handle exists on this (the UI) thread
            var token = LoadOrCreateToken(tokenFile ?? DefaultTokenFile());
            var agent = new AgentHost(new Bridge(shared.Doc.Clone()));
            var s = new McpServer(ui, agent, token, port);
            s._listener.Start();
            s.Port = ((IPEndPoint)s._listener.LocalEndpoint).Port;
            Task.Run(() => s.AcceptLoop());
            Log.Write("mcp: listening on http://127.0.0.1:" + s.Port + "/mcp");
            return s;
        }

        public void Dispose()
        {
            if (_stopped) return;
            _stopped = true;
            try { _listener.Stop(); } catch { }
            lock (_clients) { foreach (var c in _clients) { try { c.Close(); } catch { } } _clients.Clear(); }
            try
            {
                // the agent page belongs to the UI thread: close it there
                if (_ui != null && !_ui.IsDisposed) { if (_ui.InvokeRequired) _ui.BeginInvoke((Action)(() => _agent.Dispose())); else _agent.Dispose(); }
            }
            catch { }
            Log.Write("mcp: stopped");
        }

        void AcceptLoop()
        {
            while (!_stopped)
            {
                TcpClient c;
                try { c = _listener.AcceptTcpClient(); }
                catch { break; }
                bool full;
                lock (_clients) { full = _clients.Count >= MaxConnections; if (!full) _clients.Add(c); }
                if (full) { try { c.Close(); } catch { } continue; }
                Task.Run(() => Serve(c));
            }
        }

        // ---------------------------------------------------------------- HTTP/1.1

        sealed class Conn
        {
            readonly Stream _s;
            readonly byte[] _buf = new byte[8192];
            int _off, _len;
            public Conn(Stream s) { _s = s; }
            public Stream Stream { get { return _s; } }

            int Next()
            {
                if (_off == _len)
                {
                    _len = _s.Read(_buf, 0, _buf.Length);
                    _off = 0;
                    if (_len <= 0) { _len = 0; return -1; }
                }
                return _buf[_off++];
            }

            /// <summary>One line without its CR LF; null at end of stream. Throws HttpError past maxBytes.</summary>
            public string ReadLine(ref int budget)
            {
                var sb = new StringBuilder();
                int b;
                while ((b = Next()) >= 0)
                {
                    if (--budget < 0) throw new HttpError(431, "Request Header Fields Too Large");
                    if (b == '\n') { if (sb.Length > 0 && sb[sb.Length - 1] == '\r') sb.Length--; return sb.ToString(); }
                    sb.Append((char)b);
                }
                return sb.Length == 0 ? null : sb.ToString();
            }

            public byte[] ReadExact(int n)
            {
                var res = new byte[n];
                int got = 0;
                while (got < n)
                {
                    int b = Next();
                    if (b < 0) throw new EndOfStreamException();
                    res[got++] = (byte)b;
                }
                return res;
            }
        }

        sealed class HttpError : Exception { public int Status; public HttpError(int status, string msg) : base(msg) { Status = status; } }

        sealed class Request
        {
            public string Method, Target, Path;
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public byte[] Body = new byte[0];
            public string Header(string n) { string v; return Headers.TryGetValue(n, out v) ? v : null; }
        }

        void Serve(TcpClient client)
        {
            try
            {
                client.NoDelay = true;
                client.ReceiveTimeout = 120000;
                client.SendTimeout = 30000;
                var conn = new Conn(client.GetStream());
                while (!_stopped)
                {
                    Request req;
                    try { req = ReadRequest(conn); }
                    catch (HttpError he) { WriteJson(conn.Stream, he.Status, Json.Dump(Json.Map("error", he.Message)), false); return; }
                    catch { return; }   // closed, timed out, or malformed
                    if (req == null) return;
                    bool keep;
                    try { keep = Handle(req, conn.Stream); }
                    catch (Exception e)
                    {
                        Log.Error("mcp request", e);
                        try { WriteJson(conn.Stream, 500, Json.Dump(Json.Map("error", "internal error")), false); } catch { }
                        return;
                    }
                    if (!keep) return;
                }
            }
            catch { }
            finally
            {
                try { client.Close(); } catch { }
                lock (_clients) _clients.Remove(client);
            }
        }

        static Request ReadRequest(Conn c)
        {
            int budget = MaxHeaderBytes;
            string line;
            do { line = c.ReadLine(ref budget); } while (line != null && line.Length == 0);   // tolerate stray blank lines between requests
            if (line == null) return null;
            var parts = line.Split(' ');
            if (parts.Length != 3 || !parts[2].StartsWith("HTTP/1.")) throw new HttpError(400, "Bad request line");
            var r = new Request { Method = parts[0], Target = parts[1] };
            int q = r.Target.IndexOf('?');
            r.Path = q >= 0 ? r.Target.Substring(0, q) : r.Target;
            while ((line = c.ReadLine(ref budget)) != null && line.Length > 0)
            {
                int i = line.IndexOf(':');
                if (i <= 0) throw new HttpError(400, "Bad header");
                r.Headers[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
            }
            if (line == null) throw new EndOfStreamException();
            var te = r.Header("Transfer-Encoding");
            var cl = r.Header("Content-Length");
            if ((te != null || cl != null) && "100-continue".Equals(r.Header("Expect"), StringComparison.OrdinalIgnoreCase))
            {
                var cont = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
                c.Stream.Write(cont, 0, cont.Length);
            }
            if (te != null && te.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                var ms = new MemoryStream();
                for (;;)
                {
                    int b2 = MaxHeaderBytes;
                    var size = c.ReadLine(ref b2);
                    if (size == null) throw new EndOfStreamException();
                    int semi = size.IndexOf(';');
                    if (semi >= 0) size = size.Substring(0, semi);
                    int n;
                    try { n = Convert.ToInt32(size.Trim(), 16); } catch { throw new HttpError(400, "Bad chunk size"); }
                    if (n < 0 || ms.Length + n > MaxBodyBytes) throw new HttpError(413, "Request body too large");
                    if (n == 0) { for (;;) { var tl = c.ReadLine(ref b2); if (string.IsNullOrEmpty(tl)) break; } break; }
                    var chunk = c.ReadExact(n);
                    ms.Write(chunk, 0, n);
                    c.ReadLine(ref b2);   // the CR LF after the chunk
                }
                r.Body = ms.ToArray();
            }
            else if (cl != null)
            {
                int n;
                if (!int.TryParse(cl, out n) || n < 0) throw new HttpError(400, "Bad Content-Length");
                if (n > MaxBodyBytes) throw new HttpError(413, "Request body too large");
                r.Body = n == 0 ? new byte[0] : c.ReadExact(n);
            }
            else if (r.Method == "POST") throw new HttpError(411, "Content-Length required");
            return r;
        }

        static void WriteResponse(Stream s, int status, string contentType, byte[] body, bool keepAlive, string extraHeaders)
        {
            string reason;
            switch (status)
            {
                case 200: reason = "OK"; break;
                case 202: reason = "Accepted"; break;
                case 400: reason = "Bad Request"; break;
                case 401: reason = "Unauthorized"; break;
                case 403: reason = "Forbidden"; break;
                case 404: reason = "Not Found"; break;
                case 405: reason = "Method Not Allowed"; break;
                case 411: reason = "Length Required"; break;
                case 413: reason = "Payload Too Large"; break;
                case 431: reason = "Request Header Fields Too Large"; break;
                default: reason = status >= 500 ? "Internal Server Error" : "Error"; break;
            }
            var head = "HTTP/1.1 " + status + " " + reason + "\r\n" +
                (contentType != null ? "Content-Type: " + contentType + "\r\n" : "") +
                "Content-Length: " + body.Length + "\r\n" +
                "Cache-Control: no-store\r\n" +
                "X-Content-Type-Options: nosniff\r\n" +
                "Connection: " + (keepAlive ? "keep-alive" : "close") + "\r\n" +
                (extraHeaders ?? "") + "\r\n";
            var h = Encoding.ASCII.GetBytes(head);
            s.Write(h, 0, h.Length);
            if (body.Length > 0) s.Write(body, 0, body.Length);
            s.Flush();
        }

        static void WriteJson(Stream s, int status, string json, bool keepAlive, string extraHeaders = null)
        {
            WriteResponse(s, status, "application/json; charset=utf-8", new UTF8Encoding(false).GetBytes(json), keepAlive, extraHeaders);
        }

        static bool FixedTimeEquals(string a, string b)
        {
            var x = Encoding.UTF8.GetBytes(a ?? ""); var y = Encoding.UTF8.GetBytes(b ?? "");
            int d = x.Length ^ y.Length;
            for (int i = 0; i < Math.Min(x.Length, y.Length); i++) d |= x[i] ^ y[i];
            return d == 0;
        }

        static bool LoopbackHost(string host)
        {
            if (string.IsNullOrEmpty(host)) return true;   // HTTP/1.0 style clients
            string h = host.Trim();
            if (h.StartsWith("[")) { int e = h.IndexOf(']'); h = e > 0 ? h.Substring(0, e + 1) : h; }
            else { int c = h.LastIndexOf(':'); if (c >= 0) h = h.Substring(0, c); }
            return h == "127.0.0.1" || h.Equals("localhost", StringComparison.OrdinalIgnoreCase) || h == "[::1]";
        }

        /// <summary>One request; returns whether the connection stays open.</summary>
        bool Handle(Request req, Stream s)
        {
            bool keep = !"close".Equals(req.Header("Connection"), StringComparison.OrdinalIgnoreCase);
            if (req.Path != "/mcp") { WriteJson(s, 404, Json.Dump(Json.Map("error", "not found; the MCP endpoint is POST /mcp")), keep); return keep; }
            // DNS-rebinding defence: browsers always send Origin; non-browser MCP clients do not
            if (!string.IsNullOrEmpty(req.Header("Origin"))) { WriteJson(s, 403, Json.Dump(Json.Map("error", "requests with an Origin header are not allowed")), keep); return keep; }
            if (!LoopbackHost(req.Header("Host"))) { WriteJson(s, 403, Json.Dump(Json.Map("error", "bad Host header")), keep); return keep; }
            if (req.Method != "POST") { WriteJson(s, 405, Json.Dump(Json.Map("error", "use POST; this server has no SSE stream and no sessions")), keep, "Allow: POST\r\n"); return keep; }
            var auth = req.Header("Authorization") ?? "";
            bool ok = auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) && FixedTimeEquals(auth.Substring(7).Trim(), _token);
            if (!ok) { WriteJson(s, 401, Json.Dump(Json.Map("error", "missing or wrong bearer token")), keep, "WWW-Authenticate: Bearer realm=\"zotero-next-word\"\r\n"); return keep; }

            object parsed;
            try { parsed = Json.Parse(new UTF8Encoding(false).GetString(req.Body)); }
            catch { WriteJson(s, 400, Json.Dump(Rpc(null, null, Json.Map("code", -32700, "message", "Parse error"))), keep); return keep; }

            var batch = parsed as ArrayList;
            var batchArr = parsed as object[];
            if (batch != null || batchArr != null)
            {
                var replies = new List<object>();
                foreach (var m in Json.Arr(parsed))
                {
                    var r = HandleMessage(Json.Obj(m));
                    if (r != null) replies.Add(r);
                }
                if (replies.Count == 0) WriteResponse(s, 202, null, new byte[0], keep, null);
                else WriteJson(s, 200, Json.Dump(replies), keep);
                return keep;
            }
            var reply = HandleMessage(Json.Obj(parsed));
            if (reply == null) WriteResponse(s, 202, null, new byte[0], keep, null);
            else WriteJson(s, 200, Json.Dump(reply), keep);
            return keep;
        }

        // ---------------------------------------------------------------- JSON-RPC

        static Dictionary<string, object> Rpc(object id, object result, object error)
        {
            var d = Json.Map("jsonrpc", "2.0", "id", id);
            if (error != null) d["error"] = error; else d["result"] = result;
            return d;
        }

        /// <summary>The reply to one JSON-RPC message, or null for a notification (or a response from the client).</summary>
        Dictionary<string, object> HandleMessage(Dictionary<string, object> msg)
        {
            if (msg == null) return Rpc(null, null, Json.Map("code", -32600, "message", "Invalid Request"));
            bool hasId = msg.ContainsKey("id") && msg["id"] != null;
            object id = Json.Get(msg, "id");
            string method = Json.Str(msg, "method");
            if (method == null) return null;   // a response to something we never sent
            try
            {
                switch (method)
                {
                    case "initialize":
                        {
                            var p = Json.Obj(Json.Get(msg, "params"));
                            var want = Json.Str(p, "protocolVersion");
                            var version = SupportedVersions.Contains(want) ? want : SupportedVersions[0];
                            return Rpc(id, Json.Map(
                                "protocolVersion", version,
                                "capabilities", Json.Map("tools", Json.Map("listChanged", false)),
                                "serverInfo", Json.Map("name", "zotero-next-word", "title", "Zinc for Word", "version", "0.1.0"),
                                "instructions", Json.Str(Spec.Value, "instructions", "")), null);
                        }
                    case "ping":
                        return hasId ? Rpc(id, new Dictionary<string, object>(), null) : null;
                    case "tools/list":
                        return Rpc(id, Json.Map("tools", ToolList()), null);
                    case "tools/call":
                        {
                            var p = Json.Obj(Json.Get(msg, "params"));
                            var name = Json.Str(p, "name");
                            if (string.IsNullOrEmpty(name) || !IsTool(name)) return Rpc(id, null, Json.Map("code", -32602, "message", "Unknown tool: " + name));
                            var rawArgs = Json.Get(p, "arguments");
                            if (rawArgs != null && Json.Obj(rawArgs) == null) return Rpc(id, null, Json.Map("code", -32602, "message", "arguments must be an object"));
                            return Rpc(id, CallTool(name, Json.Obj(rawArgs) ?? new Dictionary<string, object>()), null);
                        }
                    default:
                        if (method.StartsWith("notifications/") || !hasId) return null;
                        return Rpc(id, null, Json.Map("code", -32601, "message", "Method not found: " + method));
                }
            }
            catch (Exception e)
            {
                var inner = e; while (inner.InnerException != null) inner = inner.InnerException;
                return hasId ? Rpc(id, null, Json.Map("code", -32603, "message", inner.Message)) : null;
            }
        }

        static Dictionary<string, object> ToolResult(string text, bool isError)
        {
            return Json.Map("content", new List<object> { Json.Map("type", "text", "text", text) }, "isError", isError);
        }

        /// <summary>
        /// Run one tool on Word's UI thread; the tool's own failures come back as an MCP tool error (isError), not a protocol error.
        /// A call that never started before the deadline is cancelled (the queued action checks it and does nothing), so it cannot run later
        /// behind a retry. A call that already started keeps the serialization gate until it really finishes, and the caller is told the outcome is unknown.
        /// </summary>
        Dictionary<string, object> CallTool(string name, Dictionary<string, object> args)
        {
            int timeout = TimeoutMs();
            if (!_gate.Wait(timeout)) return ToolResult("Error: another tool call is still running (waited " + (timeout / 1000) + " s). Try again.", true);
            bool keepGate = false;
            try
            {
                Log.Write("mcp: tools/call " + name);
                var state = new CallState();
                var run = OnUi(state, () => _agent.CallAsync(name, args, timeout));
                // the UI thread can be blocked (a modal dialog in Word): do not wait forever
                if (!run.Wait(timeout + 40000))
                {
                    if (state.TryCancel())
                        return ToolResult("Error: Word did not respond (is a dialog open in Word?). The request was cancelled before it started, so nothing was changed. Close the dialog and try again.", true);
                    // already running: it may still change the document. Hold the gate until it ends so no second call overlaps it.
                    keepGate = true;
                    run.ContinueWith(t => { var _ = t.Exception; _gate.Release(); Log.Write("mcp: " + name + " finished after the deadline"); });
                    return ToolResult("Error: outcome unknown. " + name + " started in Word but did not finish in time (is a dialog open in Word?). It may still complete; check the document before repeating it.", true);
                }
                var r = run.Result;
                if (Json.Bool(r, "ok")) return ToolResult(Json.Str(r, "json", "null"), false);
                return ToolResult("Error: " + Json.Str(r, "error", "the tool failed"), true);
            }
            catch (Exception e)
            {
                var inner = e;
                while (inner.InnerException != null) inner = inner.InnerException;
                Log.Write("mcp: " + name + " failed: " + inner.GetType().Name + ": " + inner.Message);
                return ToolResult("Error: " + inner.Message, true);
            }
            finally { if (!keepGate) _gate.Release(); }
        }

        /// <summary>queued (0) -> started (1) or cancelled (2); whichever transition happens first wins.</summary>
        sealed class CallState
        {
            int _phase;
            public bool TryStart() { return System.Threading.Interlocked.CompareExchange(ref _phase, 1, 0) == 0; }
            public bool TryCancel() { return System.Threading.Interlocked.CompareExchange(ref _phase, 2, 0) == 0; }
        }

        Task<T> OnUi<T>(CallState state, Func<Task<T>> f)
        {
            var tcs = new TaskCompletionSource<T>();
            try
            {
                _ui.BeginInvoke((Action)(async () =>
                {
                    if (!state.TryStart()) { tcs.TrySetCanceled(); return; }
                    try { tcs.TrySetResult(await f()); }
                    catch (Exception e) { tcs.TrySetException(e); }
                }));
            }
            catch (Exception e) { tcs.TrySetException(e); }
            return tcs.Task;
        }
    }
}
