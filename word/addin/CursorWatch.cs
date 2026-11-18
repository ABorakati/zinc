using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace ZoteroNext.Word
{
    /// <summary>
    /// The one cursor watcher for the citation popup and the sidebar(s). A Windows Forms timer on Word's UI thread, so every
    /// Word call it makes takes time from Word itself. It used to be two timers (popup every 250 ms, sidebar every 300 ms),
    /// each asking Word for the full <see cref="WordDoc.Cursor"/> on every tick; on a 120-citation document that is about
    /// 50 ms outside a citation and 160 ms inside one, so Word spent a third to over half of its time answering them and
    /// felt busy and hung now and then. Now, per tick:
    ///   - nothing at all unless Word is the foreground app and someone wants the cursor (popup on, or a sidebar shown);
    ///   - otherwise only <see cref="WordDoc.SelectionSig"/> (four cheap calls);
    ///   - the full Cursor() only once the selection has stood still for a tick (never while the user types or drags),
    ///     after a write through the bridge (<see cref="Invalidate"/>), and every few seconds while it sits in a citation
    ///     (to catch Undo and other edits that leave the selection where it was).
    /// </summary>
    internal static class CursorWatch
    {
        public const int TickMs = 250;
        const int RecheckInFieldMs = 4000;

        static System.Windows.Forms.Timer _timer;
        static string _seen;            // selection signature at the last tick
        static string _readSig;         // signature at the last full read
        static DateTime _readAt = DateTime.MinValue;
        static volatile bool _dirty = true;
        static Dictionary<string, object> _cursor;
        static readonly uint _pid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;

        /// <summary>False only in the test harness, whose private Word is never the foreground app.</summary>
        public static bool RequireForeground = true;

        /// <summary>Tests and diagnostics: ticks that asked Word anything, full reads, and the time spent in Word calls.</summary>
        public static int WordTicks, FullReads;
        public static double WordMs;
        /// <summary>Test harness only: act as if a sidebar were shown.</summary>
        public static bool ForceWanted;

        /// <summary>The cursor as last read (null before the first read or without a document).</summary>
        public static Dictionary<string, object> Current { get { return _cursor; } }

        /// <summary>Start the timer on the calling (Word UI) thread; calling again does nothing.</summary>
        public static void Start()
        {
            try { if (SynchronizationContext.Current == null) SynchronizationContext.SetSynchronizationContext(new System.Windows.Forms.WindowsFormsSynchronizationContext()); } catch { }
            if (_timer != null) return;
            _timer = new System.Windows.Forms.Timer { Interval = TickMs };
            _timer.Tick += (s, e) => { try { Tick(); } catch (Exception ex) { Log.Error("cursor watch", ex); } };
            _timer.Start();
        }

        public static void Stop()
        {
            try { if (_timer != null) { _timer.Stop(); _timer.Dispose(); } } catch { }
            _timer = null; _seen = null; _readSig = null; _cursor = null; _dirty = true;
        }

        /// <summary>The document changed through the add-in (insert, refresh, ...): read the cursor again at the next tick.</summary>
        public static void Invalidate() { _dirty = true; }

        public static bool WordIsForeground()
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            return pid == _pid;
        }

        static void Tick()
        {
            var b = Connect.Shared;
            if (b == null) return;
            bool fg = !RequireForeground || WordIsForeground();
            // the popup hides itself when Word loses the foreground, is minimised or Esc is pressed: no Word calls needed
            bool popupWants = Popup.PreTick(fg);
            bool paneWants = PaneControl.AnyVisible() || ForceWanted;
            if (!fg || !(popupWants || paneWants)) return;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try { Read(b, popupWants, paneWants); }
            finally { WordTicks++; WordMs += sw.Elapsed.TotalMilliseconds; }
        }

        static void Read(Bridge b, bool popupWants, bool paneWants)
        {
            string sig;
            try { sig = b.Doc.SelectionSig(); }
            catch { return; }   // Word busy (modal dialog, ...): next tick
            bool moving = sig != _seen;
            _seen = sig;
            bool inField = _cursor != null && Json.Bool(_cursor, "inField");
            bool due = !moving && (_dirty || sig != _readSig || (inField && (DateTime.Now - _readAt).TotalMilliseconds >= RecheckInFieldMs));
            bool fresh = false;
            if (due)
            {
                try
                {
                    _cursor = b.Doc.Cursor();
                    FullReads++;
                    _readSig = sig; _readAt = DateTime.Now; _dirty = false; fresh = true;
                }
                catch { return; }
            }
            if (_cursor == null) return;
            if (popupWants) Popup.OnCursor(_cursor, fresh, moving);
            if (paneWants) PaneControl.OnCursor(_cursor);
        }

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    }
}
