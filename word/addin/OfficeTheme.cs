using System;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ZoteroNext.Word
{
    /// <summary>
    /// Office's own UI theme (File > Account > Office Theme), so the sidebar and the popup look like part of Word rather than
    /// following the Windows app mode. Office writes the choice to HKCU\Software\Microsoft\Office\16.0\Common "UI Theme":
    /// 0/7 Colorful, 5 White, 3 Dark Gray, 4 Black, 6 Use system setting. The pages read it from html[data-office]
    /// (light | darkgray | black; style.css) and from prefers-color-scheme, which follows <see cref="Apply"/>.
    /// </summary>
    internal static class OfficeTheme
    {
        static string _cached = "light";
        static DateTime _readAt = DateTime.MinValue;

        /// <summary>light, darkgray or black. Re-reads the registry at most every 2 s.</summary>
        public static string Current()
        {
            if ((DateTime.Now - _readAt).TotalSeconds < 2) return _cached;
            _readAt = DateTime.Now;
            try { _cached = Read(); } catch { }
            return _cached;
        }

        static string Read()
        {
            object v = null;
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Office\16.0\Common"))
                if (k != null) v = k.GetValue("UI Theme");
            int theme = v is int i ? i : 0;
            switch (theme)
            {
                case 3: return "darkgray";
                case 4: return "black";
                case 6: return WindowsAppsLight() ? "light" : "black";   // Office's "system" dark is its Black theme
                default: return "light";                                 // Colorful (0, 7), White (5), unknown
            }
        }

        static bool WindowsAppsLight()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                var v = k == null ? null : k.GetValue("AppsUseLightTheme");
                return !(v is int i) || i != 0;
            }
        }

        /// <summary>Page background behind the content, matching Office's task pane in each theme.</summary>
        public static System.Drawing.Color Background(string theme)
        {
            switch (theme)
            {
                case "darkgray": return System.Drawing.Color.FromArgb(0x3A, 0x3A, 0x3A);
                case "black": return System.Drawing.Color.FromArgb(0x26, 0x26, 0x26);
                default: return System.Drawing.Color.FromArgb(0xFC, 0xFC, 0xFC);
            }
        }

        /// <summary>Set the page's colour scheme and html[data-office]. Call on the view's thread after navigation, and again
        /// whenever <see cref="Current"/> changes.</summary>
        public static void Apply(CoreWebView2 core, string theme)
        {
            if (core == null) return;
            try { core.Profile.PreferredColorScheme = theme == "light" ? CoreWebView2PreferredColorScheme.Light : CoreWebView2PreferredColorScheme.Dark; }
            catch (Exception e) { Log.Error("theme: colour scheme", e); }
            try { var _ = core.ExecuteScriptAsync("document.documentElement.dataset.office = '" + theme + "'"); }
            catch (Exception e) { Log.Error("theme: page", e); }
        }
    }
}
