using System;

namespace ZoteroNext.Word
{
    /// <summary>What a WebView2 page of the add-in may be and do. No WebView2 or Word object is used here, so the harness can test it.</summary>
    internal static class WebGuard
    {
        internal const string PopupUrl = "https://zn-sidebar.local/popup.html";

        /// <summary>Whether the popup's own page (the one page it shows) is at uri: a message from, or a navigation to, any other address is refused.</summary>
        internal static bool IsPopupUri(string uri)
        {
            Uri u;
            return Uri.TryCreate(uri, UriKind.Absolute, out u) && u.Scheme == "https" && string.Equals(u.Host, "zn-sidebar.local", StringComparison.OrdinalIgnoreCase)
                && u.IsDefaultPort && u.UserInfo.Length == 0 && string.Equals(u.AbsolutePath, "/popup.html", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>DevTools stay off unless the ZN_DEVTOOLS environment variable is set (to anything).</summary>
        internal static bool DevTools(string zn_devtools)
        {
            return !string.IsNullOrEmpty(zn_devtools);
        }
    }
}
