// Test plugin for plugin-host: `on-timer(999, ...)` never returns (black_box keeps the optimizer from removing the loop).
// If the pref `spin_on_startup` is true, `startup` loops forever too.
wit_bindgen::generate!({
    world: "hello",
    path: "wit",
    generate_all,
});

use exports::zinc::plugin::events::Guest as Events;
use exports::zinc::plugin::lifecycle::{Guest as Lifecycle, PluginData, Reason};
use zinc::plugin::log::{write, LogLevel};
use zinc::plugin::prefs;
use zinc::plugin::timers::TimerKind;
use zinc::plugin::types::{Error, PrefValue};

struct Plugin;

fn spin() -> ! {
    let mut n: u64 = 0;
    loop {
        n = std::hint::black_box(n.wrapping_add(1));
    }
}

impl Lifecycle for Plugin {
    fn install(_d: PluginData, _w: Reason) -> Result<(), Error> {
        Ok(())
    }

    fn startup(_data: PluginData, _why: Reason) -> Result<(), Error> {
        write(LogLevel::Info, "spin-rust startup");
        if let Some(PrefValue::Flag(true)) = prefs::get("spin_on_startup") {
            spin();
        }
        Ok(())
    }

    fn shutdown(_d: PluginData, _w: Reason) -> Result<(), Error> {
        Ok(())
    }

    fn uninstall(_d: PluginData, _w: Reason) -> Result<(), Error> {
        Ok(())
    }

    fn main_window_load(_d: PluginData, _w: u32) -> Result<(), Error> {
        Ok(())
    }

    fn main_window_unload(_d: PluginData, _w: u32) -> Result<(), Error> {
        Ok(())
    }
}

impl Events for Plugin {
    fn on_pref_changed(_s: u32, _scope: prefs::PrefScope, _name: String, _v: Option<PrefValue>) {}

    fn on_timer(timer: u32, _kind: TimerKind) {
        if timer == 999 {
            spin();
        }
        write(LogLevel::Info, &format!("spin-rust timer {timer}"));
    }

    fn on_plugin_event(_p: String, _h: exports::zinc::plugin::lifecycle::Hook, _r: Reason) {}

    fn on_locale_changed(_l: String) {}

    fn on_permission_changed(_p: String, _g: bool) {}
}

export!(Plugin);
