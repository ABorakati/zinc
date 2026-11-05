using System;
using System.Collections.Generic;

namespace ZoteroNext.Word
{
    /// <summary>
    /// The sidebar's RPC surface: {id, method, params} -> {id, result | error}. Used by the WebView2 pane and by the
    /// test harness, so the same code paths are exercised in both. doc.* methods touch Word and must run on the
    /// thread that owns it; everything else is free to run on a worker thread.
    /// </summary>
    internal sealed class Bridge
    {
        readonly WordDoc _doc;
        public Bridge(WordDoc doc) { _doc = doc; }
        public WordDoc Doc { get { return _doc; } }

        public static bool NeedsWordThread(string method) { return method != null && method.StartsWith("doc."); }

        /// <summary>Handle one request given as JSON text; always returns a JSON response text.</summary>
        public string HandleJson(string request)
        {
            object id = null;
            try
            {
                var req = Json.Obj(Json.Parse(request));
                id = Json.Get(req, "id");
                var result = Call(Json.Str(req, "method"), Json.Obj(Json.Get(req, "params")) ?? new Dictionary<string, object>());
                return Json.Dump(Json.Map("id", id, "result", result));
            }
            catch (Exception e)
            {
                var inner = e;
                while (inner.InnerException != null) inner = inner.InnerException;
                return Json.Dump(Json.Map("id", id, "error", Json.Map("message", inner.Message, "type", inner.GetType().Name)));
            }
        }

        public object Call(string method, Dictionary<string, object> p)
        {
            switch (method)
            {
                case "host.info":
                    return Json.Map("version", "0.1.0", "library", Library.Info(), "uri", Library.UriBase(), "settings", Settings.Load(), "zn", ZnClient.Status());
                case "settings.get": return Settings.Load();
                case "settings.set": return Settings.Patch(p);

                case "lib.search": return Library.Search(p);
                case "lib.items": return Library.Items(p);
                case "lib.byUri": return Library.ByUri(p);
                case "lib.uriBase": return Library.UriBase();

                case "style.search": return Styles.Search(Json.Str(p, "q", ""), Json.Int(p, "limit", 40));
                case "style.xml": return Json.Map("id", Json.Str(p, "id"), "xml", Styles.StyleXml(Json.Str(p, "id")));
                case "locale.xml": return Json.Map("lang", Json.Str(p, "lang"), "xml", Styles.LocaleXml(Json.Str(p, "lang")));

                case "zn.status": return ZnClient.Status();
                case "zn.lookup": return ZnClient.Lookup(Json.Str(p, "doi"));
                case "zn.reveal": return ZnClient.Reveal(Json.Str(p, "key"));
                case "app.openUrl":
                    {
                        var u = Json.Str(p, "url", "");
                        if (!(u.StartsWith("https://") || u.StartsWith("http://"))) throw new ArgumentException("only http(s) links can be opened");
                        System.Diagnostics.Process.Start(u);
                        return Json.Map("ok", true);
                    }

                case "doc.state": return _doc.State();
                case "doc.fields": return _doc.Fields();
                case "doc.cursor": return _doc.Cursor();
                case "doc.insert": return _doc.InsertField(p);
                case "doc.set": return _doc.SetField(p);
                case "doc.delete": return _doc.DeleteField(p);
                case "doc.unlink": return _doc.RemoveFieldCode(p);
                case "doc.convert": return _doc.ConvertField(p);
                case "doc.select": return _doc.SelectField(p);
                case "doc.getPrefs": return _doc.GetPrefs();
                case "doc.setPrefs": return _doc.SetPrefs(p);
                case "doc.begin": return _doc.Begin(p);
                case "doc.end": return _doc.End();
                case "doc.save": return _doc.Save();
                default: throw new ArgumentException("unknown method: " + method);
            }
        }
    }
}
