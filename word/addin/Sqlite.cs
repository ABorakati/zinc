// Minimal read-only SQLite access through winsqlite3.dll, the SQLite that ships with Windows 10/11 (older
// builds may omit FTS5; Library.Search falls back to LIKE queries when FTS5 is unavailable). No NuGet/native
// dependency, nothing to register. The library database is opened READ ONLY: zotero-next may be writing it
// (WAL) at the same moment, and this add-in never writes to it.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace ZoteroNext.Word
{
    internal static class Native
    {
        const string Dll = "winsqlite3.dll";
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_close_v2(IntPtr db);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr stmt, IntPtr tail);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_step(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_finalize(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_bind_text(IntPtr stmt, int i, byte[] text, int n, IntPtr destructor);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_bind_int64(IntPtr stmt, int i, long v);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_bind_null(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_column_count(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr sqlite3_column_text(IntPtr stmt, int col);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_column_bytes(IntPtr stmt, int col);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_column_type(IntPtr stmt, int col);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr sqlite3_errmsg(IntPtr db);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_busy_timeout(IntPtr db, int ms);
    }

    internal sealed class SqliteException : Exception
    {
        public SqliteException(string message) : base(message) { }
    }

    /// <summary>A read-only connection. Not thread safe: open one per call.</summary>
    internal sealed class SqliteReader : IDisposable
    {
        const int OPEN_READONLY = 0x1;
        const int OPEN_NOMUTEX = 0x8000;
        static readonly IntPtr Transient = new IntPtr(-1);
        IntPtr _db;

        static byte[] Utf8Z(string s) { var b = Encoding.UTF8.GetBytes(s ?? ""); var z = new byte[b.Length + 1]; Buffer.BlockCopy(b, 0, z, 0, b.Length); return z; }

        public SqliteReader(string path)
        {
            int rc = Native.sqlite3_open_v2(Utf8Z(path), out _db, OPEN_READONLY | OPEN_NOMUTEX, IntPtr.Zero);
            if (rc != 0) { var m = Err(); Dispose(); throw new SqliteException("cannot open " + path + ": " + m); }
            Native.sqlite3_busy_timeout(_db, 3000);
        }

        string Err() { return _db == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(Native.sqlite3_errmsg(_db)); }

        static string Text(IntPtr stmt, int col)
        {
            if (Native.sqlite3_column_type(stmt, col) == 5) return null; // SQLITE_NULL
            IntPtr p = Native.sqlite3_column_text(stmt, col);
            if (p == IntPtr.Zero) return null;
            int n = Native.sqlite3_column_bytes(stmt, col);
            var buf = new byte[n];
            Marshal.Copy(p, buf, 0, n);
            return Encoding.UTF8.GetString(buf);
        }

        /// <summary>Run a query; every row is returned as string[] (NULL -> null).</summary>
        public List<string[]> Query(string sql, params object[] args)
        {
            IntPtr stmt;
            if (Native.sqlite3_prepare_v2(_db, Utf8Z(sql), -1, out stmt, IntPtr.Zero) != 0) throw new SqliteException(Err() + " in: " + sql);
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    object a = args[i];
                    if (a == null) Native.sqlite3_bind_null(stmt, i + 1);
                    else if (a is int || a is long) Native.sqlite3_bind_int64(stmt, i + 1, Convert.ToInt64(a));
                    else { var b = Encoding.UTF8.GetBytes(Convert.ToString(a)); Native.sqlite3_bind_text(stmt, i + 1, b, b.Length, Transient); }
                }
                var rows = new List<string[]>();
                int cols = Native.sqlite3_column_count(stmt);
                while (true)
                {
                    int rc = Native.sqlite3_step(stmt);
                    if (rc == 100) { var r = new string[cols]; for (int c = 0; c < cols; c++) r[c] = Text(stmt, c); rows.Add(r); }
                    else if (rc == 101) break;
                    else throw new SqliteException(Err() + " (rc " + rc + ")");
                }
                return rows;
            }
            finally { Native.sqlite3_finalize(stmt); }
        }

        public void Dispose() { if (_db != IntPtr.Zero) { Native.sqlite3_close_v2(_db); _db = IntPtr.Zero; } }
    }
}
