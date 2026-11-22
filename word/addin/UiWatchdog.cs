using System;
using System.Threading;

namespace ZoteroNext.Word
{
    /// <summary>
    /// Says in the add-in log when Word's UI thread stops answering, and what the add-in was doing at the time. A timer on
    /// the UI thread beats every half second; a background thread checks the beat. If it is more than 2 s old, Word is
    /// busy: the log gets the add-in's current <see cref="Phase"/> (or "none": the add-in was not running, so the time is
    /// Word's own), again every 30 s while it lasts, and how long it lasted once the beat comes back. The background thread
    /// never calls Word and never touches the UI thread, so it cannot add to a hang.
    /// </summary>
    internal static class UiWatchdog
    {
        const int BeatMs = 500, StuckMs = 2000, RepeatMs = 30000;

        static volatile string _phase;
        static long _phaseSince;
        static long _beat = Tick();
        static volatile System.Windows.Forms.Timer _timer;
        static Thread _thread;

        /// <summary>A tick count as a non-negative number: Environment.TickCount is a signed int that turns negative after 24.9 days of uptime.</summary>
        internal static long Widen(int tick) { return unchecked((uint)tick); }

        static long Tick() { return Widen(Environment.TickCount); }

        /// <summary>Milliseconds from then to now (both from <see cref="Widen"/>), right across the counter's wrap at 49.7 days.</summary>
        internal static long Since(long now, long then) { return (now - then) & 0xFFFFFFFFL; }

        /// <summary>What the add-in is doing on the UI thread right now (null when it is not running).</summary>
        public static string Phase { get { return _phase; } }

        /// <summary>Mark the start of a piece of UI-thread work; returns the previous phase, to hand back to <see cref="Exit"/>.</summary>
        public static string Enter(string phase)
        {
            var prev = _phase;
            _phase = prev == null ? phase : prev + " > " + phase;
            if (prev == null) Interlocked.Exchange(ref _phaseSince, Tick());
            return prev;
        }

        public static void Exit(string prev) { _phase = prev; }

        /// <summary>Start on the UI thread (calling again does nothing).</summary>
        public static void Start()
        {
            if (_timer != null) return;
            Interlocked.Exchange(ref _beat, Tick());
            var timer = new System.Windows.Forms.Timer { Interval = BeatMs };
            _timer = timer;
            timer.Tick += (s, e) => Interlocked.Exchange(ref _beat, Tick());
            timer.Start();
            _thread = new Thread(() => Watch(timer)) { IsBackground = true, Name = "zn-ui-watchdog", Priority = ThreadPriority.BelowNormal };
            _thread.Start();
        }

        public static void Stop()
        {
            try { if (_timer != null) { _timer.Stop(); _timer.Dispose(); } } catch { }
            _timer = null;
        }

        // watches until its own timer is stopped: a Stop followed by a Start before this thread wakes must not leave two watchers
        static void Watch(System.Windows.Forms.Timer mine)
        {
            bool stuck = false;
            long reportedAt = 0, stuckFrom = 0;
            string worst = null;
            while (ReferenceEquals(_timer, mine))
            {
                Thread.Sleep(BeatMs);
                long now = Tick();
                long age = Since(now, Interlocked.Read(ref _beat));
                var phase = _phase;
                if (age > StuckMs)
                {
                    if (phase != null) worst = phase;
                    if (!stuck) stuckFrom = Interlocked.Read(ref _beat);
                    if (!stuck || Since(now, reportedAt) >= RepeatMs)
                    {
                        string since = phase == null ? "" : " (for " + Since(now, Interlocked.Read(ref _phaseSince)) / 1000.0 + " s)";
                        Log.Write("watchdog: Word's UI thread has not answered for " + age / 1000.0 + " s; add-in doing: " + (phase ?? "none (Word's own work)") + since);
                        reportedAt = now;
                    }
                    stuck = true;
                }
                else if (stuck)
                {
                    Log.Write("watchdog: Word's UI thread answers again after " + Since(now, stuckFrom) / 1000.0 + " s (add-in doing while stuck: " + (worst ?? "none") + ")");
                    stuck = false; worst = null;
                }
            }
        }
    }
}
