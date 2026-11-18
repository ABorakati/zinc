//! The plugin host: engine, linker (generic, built from the component's own import types), one Store per plugin, calls with
//! epoch-based timeouts. No `bindgen!`: every import is a dynamically typed `Val` function, so one piece of code serves every world.
use crate::conv::{camel, iface_name, json_to_val, kebab, val_to_json, ResIds};
use crate::state::{Bridge, Limits, Out, Parent, St};
use crate::wasi;
use wasmtime::error::Context;
use wasmtime::{format_err as anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use wasmtime::component::types::{ComponentFunc, ComponentItem};
use wasmtime::component::{Component, ComponentExportIndex, Func, Linker, LinkerInstance, ResourceDynamic, ResourceType, Type, Val};
use wasmtime::{Config, Engine, OptLevel, Store, StoreContextMut, UpdateDeadline};

pub const TICK_MS: u64 = 10;
const TIMEOUT_MARK: &str = "zhw-timeout";

pub fn make_engine() -> Result<Engine> {
    let mut c = Config::new();
    c.epoch_interruption(true);
    c.wasm_component_model(true);
    match std::env::var("ZHW_OPT").as_deref() {
        Ok("none") => {
            c.cranelift_opt_level(OptLevel::None);
        }
        Ok("speed") => {
            c.cranelift_opt_level(OptLevel::Speed);
        }
        _ => {}
    }
    Engine::new(&c)
}

/// Our own copy of the epoch counter (Engine::current_epoch is not public): the ticker thread bumps both.
pub static CLOCK: AtomicU64 = AtomicU64::new(0);

pub fn now_epoch() -> u64 {
    CLOCK.load(Ordering::Relaxed)
}

pub fn start_ticker(engine: &Engine) {
    let e = engine.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
        CLOCK.fetch_add(1, Ordering::Relaxed);
        e.increment_epoch();
    });
}

pub struct HostCfg {
    pub max_memory_mb: usize,
    pub prefer_cwasm: bool,
    /// "iface-short.function" imports implemented natively in Rust instead of going to the bridge.
    pub native: HashSet<String>,
}

pub struct Slot {
    pub id: String,
    pub dead: AtomicBool,
    store: tokio::sync::Mutex<Store<St>>,
    funcs: HashMap<(String, String), (Func, ComponentFunc)>,
    pub peak: Arc<AtomicUsize>,
    pub native_calls: Arc<AtomicU64>,
    pub bridged_calls: Arc<AtomicU64>,
}

pub struct Host {
    pub engine: Engine,
    pub cfg: Arc<HostCfg>,
    pub out: Out,
    pub bridge: Option<Arc<Bridge>>,
    pub parent: Arc<Parent>,
    pub slots: Mutex<HashMap<String, Arc<Slot>>>,
}

fn short(iface: &str) -> String {
    iface_name(iface).trim_start_matches("zinc:plugin/").to_string()
}

fn ticks(ms: u64) -> u64 {
    ms.div_ceil(TICK_MS).max(1)
}

// ---- linker ------------------------------------------------------------------------------------------------------------

fn build_linker(engine: &Engine, comp: &Component, cfg: &Arc<HostCfg>) -> Result<(Linker<St>, Arc<HashMap<String, u32>>)> {
    let ct = comp.component_type();
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut seen: Vec<(ResourceType, u32)> = Vec::new();
    for (name, ext) in ct.imports(engine) {
        if let ComponentItem::ComponentInstance(ci) = ext.ty {
            let iface = iface_name(name);
            for (n, e) in ci.exports(engine) {
                if let ComponentItem::Resource(rt) = e.ty {
                    // The same resource type shows up in several interfaces (`pollable` in poll, clocks, streams): one id for all.
                    let id = match seen.iter().find(|(t, _)| *t == rt) {
                        Some((_, id)) => *id,
                        None => {
                            let id = seen.len() as u32 + 1;
                            seen.push((rt, id));
                            id
                        }
                    };
                    ids.insert(format!("{iface}#{n}"), id);
                }
            }
        }
    }
    let ids = Arc::new(ids);
    let mut linker: Linker<St> = Linker::new(engine);
    for (name, ext) in ct.imports(engine) {
        match ext.ty {
            ComponentItem::ComponentInstance(ci) => {
                let iface = iface_name(name);
                let mut li = linker.instance(name)?;
                for (n, e) in ci.exports(engine) {
                    match e.ty {
                        ComponentItem::ComponentFunc(_) => define_func(&mut li, &iface, n, cfg.clone(), ids.clone())?,
                        ComponentItem::Resource(_) => {
                            let tid = ids[&format!("{iface}#{n}")];
                            let is_wasi = iface.starts_with("wasi:");
                            let (di, dn) = (iface.clone(), n.to_string());
                            li.resource_async(n, ResourceType::host_dynamic(tid), move |cx, rep| {
                                if !is_wasi {
                                    if let Some(b) = &cx.data().bridge {
                                        b.notify(json!({"t":"call","id":0,"plugin":cx.data().id,"iface":di,"fn":format!("[resource-drop]{dn}"),"args":[rep as i32]}));
                                    }
                                }
                                Box::new(async { Ok(()) })
                            })?;
                        }
                        _ => {}
                    }
                }
            }
            ComponentItem::ComponentFunc(_) => bail!("root-level function import {name} is not supported"),
            _ => {}
        }
    }
    Ok((linker, ids))
}

fn define_func(li: &mut LinkerInstance<'_, St>, iface: &str, fname: &str, cfg: Arc<HostCfg>, ids: Arc<HashMap<String, u32>>) -> Result<()> {
    let iface = iface.to_string();
    let f = fname.to_string();
    let is_wasi = iface.starts_with("wasi:");
    let native = !is_wasi && cfg.native.contains(&format!("{}.{}", short(&iface), f));
    li.func_new_async(fname, move |mut cx, ty, params, results| {
        let iface = iface.clone();
        let f = f.clone();
        let ids = ids.clone();
        Box::new(async move {
            if is_wasi {
                return wasi::call(&mut cx, &iface, &f, params, results);
            }
            if native {
                return native_call(&mut cx, &iface, &f, params, results);
            }
            bridged(cx, ty, &iface, &f, &ids, params, results).await
        })
    })
}

/// Imports implemented in Rust. `log.write` is the "hot" one: a plugin calls it often and it needs no TypeScript.
fn native_call(cx: &mut StoreContextMut<'_, St>, iface: &str, f: &str, params: &[Val], results: &mut [Val]) -> Result<()> {
    cx.data().native_calls.fetch_add(1, Ordering::Relaxed);
    match (short(iface).as_str(), f) {
        ("log", "write") => {
            let (Some(Val::Enum(level)), Some(Val::String(msg))) = (params.first(), params.get(1)) else { bail!("log.write: bad arguments") };
            let id = cx.data().id.clone();
            cx.data().send(json!({"t":"log","plugin":id,"level":level,"message":msg}));
        }
        ("log", "debug-enabled") => results[0] = Val::Bool(false),
        _ => bail!("{iface}#{f} has no native implementation"),
    }
    Ok(())
}

async fn bridged(mut cx: StoreContextMut<'_, St>, ty: ComponentFunc, iface: &str, f: &str, ids: &HashMap<String, u32>, params: &[Val], results: &mut [Val]) -> Result<()> {
    // Everything from here to the return is host work (conversion, the bridge, the handler): it does not count against the
    // plugin's active-time budget.
    let remaining = cx.data().deadline_epoch.saturating_sub(now_epoch());
    let r = bridged_inner(&mut cx, ty, iface, f, ids, params, results).await;
    cx.data_mut().deadline_epoch = now_epoch() + remaining;
    r
}

async fn bridged_inner(cx: &mut StoreContextMut<'_, St>, ty: ComponentFunc, iface: &str, f: &str, ids: &HashMap<String, u32>, params: &[Val], results: &mut [Val]) -> Result<()> {
    cx.data().bridged_calls.fetch_add(1, Ordering::Relaxed);
    let mut args: Vec<Value> = params.iter().map(|p| val_to_json(&mut *cx, p)).collect::<Result<_>>()?;
    let ctor = f.strip_prefix("[constructor]").map(str::to_string);
    let mut ctor_rep = 0;
    if ctor.is_some() {
        ctor_rep = cx.data().next_rep;
        cx.data_mut().next_rep += 1;
        args.insert(0, json!(ctor_rep));
    }
    let (plugin, bridge, parent, engine) = {
        let d = cx.data();
        (d.id.clone(), d.bridge.clone(), d.parent.clone(), d.engine.clone())
    };
    cx.data_mut().waiting += 1;
    cx.data().send(json!({"t":"waiting","plugin":plugin,"n":cx.data().waiting}));

    let mut r = match &bridge {
        Some(b) => b.call(&plugin, iface, f, args.clone()).await,
        None => json!({"ok":false,"error":{"kind":"no-handler"}}),
    };
    if r["error"]["kind"] == "no-handler" {
        r = parent.import(&plugin, iface, f, args).await;
    }

    cx.data_mut().waiting -= 1;
    cx.data().send(json!({"t":"waiting","plugin":plugin,"n":cx.data().waiting}));

    if let Some(name) = ctor {
        let tid = *ids.get(&format!("{iface}#{name}")).ok_or_else(|| anyhow!("unknown resource {name}"))?;
        if r["ok"] != true {
            // The guest does not wait for a constructor, and an error shows at its first method call (same as the Bun host).
            cx.data().send(json!({"t":"log","plugin":plugin,"level":"warn","message":format!("{iface}#{f} failed: {}", r["error"])}));
        }
        results[0] = Val::Resource(ResourceDynamic::new_own(ctor_rep, tid).try_into_resource_any(&mut *cx)?);
        return Ok(());
    }

    let rtys: Vec<Type> = ty.results().collect();
    let res = ResIds { iface, ids };
    if r["ok"] != true {
        let kind = r["error"]["kind"].as_str().unwrap_or("internal");
        if kind == "wit" {
            if let Some(Type::Result(rt)) = rtys.first() {
                let payload = &r["error"]["payload"];
                let p = match rt.err() {
                    Some(t) => Some(Box::new(json_to_val(&mut *cx, &t, payload, &res)?)),
                    None => None,
                };
                results[0] = Val::Result(Err(p));
                return Ok(());
            }
        }
        bail!("host import {iface}#{f} failed: {}", r["error"]);
    }
    let value = &r["value"];
    match rtys.first() {
        None => {}
        Some(Type::Result(rt)) => {
            let p = match rt.ok() {
                Some(t) => Some(Box::new(json_to_val(&mut *cx, &t, value, &res)?)),
                None => None,
            };
            results[0] = Val::Result(Ok(p));
        }
        Some(t) => results[0] = json_to_val(&mut *cx, t, value, &res)?,
    }
    Ok(())
}

// ---- host ---------------------------------------------------------------------------------------------------------------

pub struct LoadInfo {
    pub compile_ms: f64,
    pub link_ms: f64,
    pub instantiate_ms: f64,
    pub from_cwasm: bool,
}

impl Host {
    pub async fn load(self: &Arc<Self>, id: &str, dir: &Path, wasm_name: &str) -> Result<LoadInfo> {
        let wasm = dir.join(wasm_name);
        let cwasm: PathBuf = wasm.with_extension("cwasm");
        let t0 = Instant::now();
        let from_cwasm = self.cfg.prefer_cwasm && cwasm.exists();
        let comp = if from_cwasm {
            // SAFETY: the file was produced by `zhw precompile` of this same version.
            unsafe { Component::deserialize_file(&self.engine, &cwasm)? }
        } else {
            Component::from_file(&self.engine, &wasm).with_context(|| format!("compile {}", wasm.display()))?
        };
        let compile_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = Instant::now();
        let (linker, res_ids) = build_linker(&self.engine, &comp, &self.cfg)?;
        let pre = linker.instantiate_pre(&comp)?;
        let link_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let peak = Arc::new(AtomicUsize::new(0));
        let native_calls = Arc::new(AtomicU64::new(0));
        let bridged_calls = Arc::new(AtomicU64::new(0));
        let st = St {
            id: id.to_string(),
            engine: self.engine.clone(),
            limits: Limits { max_memory: self.cfg.max_memory_mb << 20, max_table_elems: 1_000_000, peak: peak.clone() },
            out: self.out.clone(),
            bridge: self.bridge.clone(),
            parent: self.parent.clone(),
            res_ids,
            next_rep: 1,
            deadline_epoch: now_epoch() + ticks(15_000),
            waiting: 0,
            stdout_buf: String::new(),
            stderr_buf: String::new(),
            native_calls: native_calls.clone(),
            bridged_calls: bridged_calls.clone(),
        };
        let mut store = Store::new(&self.engine, st);
        store.limiter(|s| &mut s.limits);
        store.epoch_deadline_callback(|cx| {
            let d = cx.data();
            if now_epoch() >= d.deadline_epoch {
                Err(anyhow!(TIMEOUT_MARK))
            } else {
                // Yield to the runtime every tick so a spinning plugin cannot starve the others, then check the budget again.
                Ok(UpdateDeadline::Yield(1))
            }
        });
        store.set_epoch_deadline(1);

        let t2 = Instant::now();
        let inst = pre.instantiate_async(&mut store).await.context("instantiate")?;
        let instantiate_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let mut funcs = HashMap::new();
        for (name, ext) in comp.component_type().exports(&self.engine) {
            if let ComponentItem::ComponentInstance(ci) = ext.ty {
                let Some(iidx) = inst.get_export_index(&mut store, None, name) else { continue };
                for (fname, e) in ci.exports(&self.engine) {
                    if let ComponentItem::ComponentFunc(ft) = e.ty {
                        let fidx: Option<ComponentExportIndex> = inst.get_export_index(&mut store, Some(&iidx), fname);
                        if let Some(func) = fidx.and_then(|i| inst.get_func(&mut store, i)) {
                            funcs.insert((short(name), fname.to_string()), (func, ft));
                        }
                    }
                }
            }
        }
        if !funcs.keys().any(|(i, _)| i == "lifecycle") {
            bail!("component does not export lifecycle");
        }
        let slot = Arc::new(Slot { id: id.to_string(), dead: AtomicBool::new(false), store: tokio::sync::Mutex::new(store), funcs, peak, native_calls, bridged_calls });
        self.slots.lock().unwrap().insert(id.to_string(), slot);
        Ok(LoadInfo { compile_ms, link_ms, instantiate_ms, from_cwasm })
    }

    pub fn unload(&self, id: &str) {
        self.slots.lock().unwrap().remove(id);
    }

    pub async fn call(&self, plugin: &str, iface: &str, f: &str, args: &[Value], timeout_ms: Option<u64>) -> Value {
        let slot = self.slots.lock().unwrap().get(plugin).cloned();
        let Some(slot) = slot else { return json!({"ok":false,"error":{"kind":"not-loaded","plugin":plugin}}) };
        if slot.dead.load(Ordering::Relaxed) {
            return json!({"ok":false,"error":{"kind":"disabled","plugin":plugin,"reason":"the plugin trapped or timed out earlier"}});
        }
        let sh = short(iface);
        let fk = kebab(f);
        let Some((func, fty)) = slot.funcs.get(&(sh.clone(), fk.clone())).or_else(|| slot.funcs.get(&(sh.clone(), f.to_string()))).cloned() else {
            return json!({"ok":false,"error":{"kind":"no-such-export","iface":sh,"fn":camel(f)}});
        };
        let budget = timeout_ms.unwrap_or(if sh == "lifecycle" && matches!(fk.as_str(), "startup" | "install" | "shutdown" | "uninstall") { 10_000 } else { 5_000 });
        let mut guard = slot.store.lock().await; // one call at a time per plugin, like the supervisor's queue
        if slot.dead.load(Ordering::Relaxed) {
            return json!({"ok":false,"error":{"kind":"disabled","plugin":plugin,"reason":"the plugin trapped or timed out earlier"}});
        }
        let ids = guard.data().res_ids.clone();
        let rid = ResIds { iface: "", ids: &ids };
        let mut params = Vec::new();
        for (i, (pname, pty)) in fty.params().enumerate() {
            let a = args.get(i).unwrap_or(&Value::Null);
            match json_to_val(&mut *guard, &pty, a, &rid) {
                Ok(v) => params.push(v),
                Err(e) => return json!({"ok":false,"error":{"kind":"internal","message":format!("argument {pname}: {e:#}")}}),
            }
        }
        let mut results = vec![Val::Bool(false); fty.results().len()];
        let epoch = now_epoch();
        guard.data_mut().deadline_epoch = epoch + ticks(budget);
        guard.set_epoch_deadline(1);
        let r = func.call_async(&mut *guard, &params, &mut results).await;
        match r {
            Ok(()) => {
                match results.first() {
                    None => json!({"ok":true,"value":null}),
                    Some(Val::Result(Ok(p))) => match p {
                        Some(p) => match val_to_json(&mut *guard, p) {
                            Ok(v) => json!({"ok":true,"value":v}),
                            Err(e) => json!({"ok":false,"error":{"kind":"internal","message":format!("{e:#}")}}),
                        },
                        None => json!({"ok":true,"value":null}),
                    },
                    Some(Val::Result(Err(p))) => {
                        let payload = match p {
                            Some(p) => val_to_json(&mut *guard, p).unwrap_or(Value::Null),
                            None => Value::Null,
                        };
                        json!({"ok":false,"error":{"kind":"wit","payload":payload}})
                    }
                    Some(v) => match val_to_json(&mut *guard, v) {
                        Ok(v) => json!({"ok":true,"value":v}),
                        Err(e) => json!({"ok":false,"error":{"kind":"internal","message":format!("{e:#}")}}),
                    },
                }
            }
            Err(e) => {
                let msg = format!("{e:#}");
                slot.dead.store(true, Ordering::Relaxed);
                let error = if msg.contains(TIMEOUT_MARK) {
                    json!({"kind":"timeout","ms":budget,"phase":format!("{sh}#{fk}")})
                } else {
                    json!({"kind":"trap","message":msg})
                };
                let note = if msg.contains(TIMEOUT_MARK) { format!("timed out after {budget} ms in {sh}#{fk}") } else { msg };
                self.out.send(json!({"t":"plugin-exit","plugin":plugin,"message":note}));
                json!({"ok":false,"error":error})
            }
        }
    }

    pub fn stats(&self) -> Value {
        let slots = self.slots.lock().unwrap();
        let v: Vec<Value> = slots
            .values()
            .map(|s| json!({"plugin":s.id,"peakMemoryBytes":s.peak.load(Ordering::Relaxed),"dead":s.dead.load(Ordering::Relaxed),"nativeCalls":s.native_calls.load(Ordering::Relaxed),"bridgedCalls":s.bridged_calls.load(Ordering::Relaxed)}))
            .collect();
        json!({"plugins":v,"rssBytes":crate::rss_bytes()})
    }
}
