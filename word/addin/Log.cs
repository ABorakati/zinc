using System;
using System.IO;

[assembly: System.Runtime.InteropServices.ComVisible(false)]
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("ZoteroNextWord.Harness")]

namespace ZoteroNext.Word
{
    /// <summary>Tiny file log (%LOCALAPPDATA%\ZoteroNextWord\addin.log) for diagnosing load problems inside Word.</summary>
    internal static class Log
    {
        static readonly object L = new object();
        public static void Write(string msg)
        {
            try
            {
                lock (L)
                {
                    Directory.CreateDirectory(Settings.CacheDir);
                    var p = Path.Combine(Settings.CacheDir, "addin.log");
                    try { if (File.Exists(p) && new FileInfo(p).Length > 200000) File.Delete(p); } catch { }
                    File.AppendAllText(p, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + msg + Environment.NewLine);
                }
            }
            catch { }
        }
        public static void Error(string what, Exception e) { Write(what + ": " + e); }
    }
}
