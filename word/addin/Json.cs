using System;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace ZoteroNext.Word
{
    /// <summary>JSON via the in-box JavaScriptSerializer (no extra assemblies to load inside Word).</summary>
    internal static class Json
    {
        static JavaScriptSerializer Ser() { return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 }; }
        public static string Dump(object o) { return Ser().Serialize(o); }
        public static object Parse(string s) { return Ser().DeserializeObject(s); }

        public static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }
        public static object[] Arr(object o)
        {
            if (o is object[] a) return a;
            if (o is ArrayList l) return l.ToArray();
            if (o is IEnumerable<object> e) return new List<object>(e).ToArray();
            return new object[0];
        }
        public static string Str(Dictionary<string, object> d, string k, string def = null)
        {
            object v; if (d != null && d.TryGetValue(k, out v) && v != null) return Convert.ToString(v); return def;
        }
        public static int Int(Dictionary<string, object> d, string k, int def = 0)
        {
            object v; if (d != null && d.TryGetValue(k, out v) && v != null) { try { return Convert.ToInt32(v); } catch { } } return def;
        }
        public static bool Bool(Dictionary<string, object> d, string k, bool def = false)
        {
            object v; if (d != null && d.TryGetValue(k, out v) && v is bool b) return b; return def;
        }
        public static object Get(Dictionary<string, object> d, string k)
        {
            object v; if (d != null && d.TryGetValue(k, out v)) return v; return null;
        }
        public static Dictionary<string, object> Map(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }
    }
}
