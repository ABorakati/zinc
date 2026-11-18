// Test plugin for plugin-host. Startup logs a line, reads a pref, tries to read the environment and a file (both must
// fail: no WASI), and asks for a timer. `on-timer` logs that it fired.
wit_bindgen::generate!({
    world: "hello",
    path: "wit",
    generate_all,
});

use exports::zinc::plugin::events::Guest as Events;
use exports::zinc::plugin::lifecycle::{Guest as Lifecycle, PluginData, Reason};
use zinc::plugin::log::{write, LogLevel};
use zinc::plugin::prefs;
use zinc::plugin::timers::{self, TimerKind};
use zinc::plugin::types::{Error, PrefValue};

struct Plugin;

fn info(msg: String) {
    write(LogLevel::Info, &msg);
}

impl Lifecycle for Plugin {
    fn install(_d: PluginData, _w: Reason) -> Result<(), Error> {
        Ok(())
    }

    fn startup(data: PluginData, _why: Reason) -> Result<(), Error> {
        info(format!("hello-rust startup {} {}", data.id, data.version));
        match prefs::get("greeting") {
            Some(PrefValue::Text(s)) => info(format!("pref greeting={s}")),
            Some(_) => info("pref greeting has another type".to_string()),
            None => info("pref greeting missing".to_string()),
        }
        // No WASI: the environment is empty and no directory is open.
        eprintln!("hello-rust stderr line");
        info(format!("env_vars={}", std::env::vars().count()));
        match std::fs::read_to_string("C:/Windows/win.ini") {
            Ok(_) => info("fs_read=ok".to_string()),
            Err(_) => info("fs_read=err".to_string()),
        }
        match timers::set_timeout(10) {
            Ok(id) => info(format!("timer=ok({id})")),
            Err(Error::Unavailable(s)) => info(format!("timer=unavailable({s})")),
            Err(_) => info("timer=err".to_string()),
        }
        Ok(())
    }

    fn shutdown(_d: PluginData, _w: Reason) -> Result<(), Error> {
        info("hello-rust shutdown".to_string());
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
        info(format!("timer {timer} fired"));
    }

    fn on_plugin_event(_p: String, _h: exports::zinc::plugin::lifecycle::Hook, _r: Reason) {}

    fn on_locale_changed(_l: String) {}

    fn on_permission_changed(_p: String, _g: bool) {}
}

export!(Plugin);
