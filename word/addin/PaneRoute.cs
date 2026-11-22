using System.Collections.Generic;

namespace ZoteroNext.Word
{
    /// <summary>
    /// Which sidebar a ribbon command is for. Every Word window has a sidebar of its own, and each one runs the same
    /// controller against the same active document, so a command sent to all of them is carried out once per sidebar.
    /// A sidebar is made by Word (the factory builds it from its ProgId), so the add-in cannot hand the new control its window;
    /// the window is announced just before the pane is created and the control's constructor takes it. No Word object is used here.
    /// </summary>
    internal static class PaneRoute
    {
        static long _claim;

        /// <summary>The Word window (its handle) a sidebar that is about to be created is for.</summary>
        internal static void Expect(long owner) { _claim = owner; }

        /// <summary>Taken by the control's constructor: the window announced for it, or 0 when none was.</summary>
        internal static long Take() { long o = _claim; _claim = 0; return o; }

        /// <summary>
        /// The sidebars (by index into owners, the window each belongs to) that a command for the window target goes to.
        /// A sidebar whose window is not known (0) cannot be told apart from the right one, so it is included.
        /// </summary>
        internal static List<int> Targets(IList<long> owners, long target)
        {
            var r = new List<int>();
            for (int i = 0; i < owners.Count; i++) if (owners[i] == target || owners[i] == 0) r.Add(i);
            return r;
        }
    }
}
