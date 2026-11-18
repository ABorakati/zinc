//! The plugin host: engine, generic linker (built from each component's own import types), one Store per plugin,
//! calls with epoch-based active CPU timeouts, import-call limits, re-entrancy refusal, and native/forwarded dispatch.
use crate::conv::{camel, iface_name, json_to_val, kebab, val_to_json_typed, ResIds};
use crate::native::{has_native_impl, AppManager, L10nManager, LogManager, PrefsManager, TimerManager, NATIVE_FAMILIES};
use crate::state::{Grants, Limits, Out, Parent, St};
use crate::wasi;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use wasmtime::component::types::{ComponentFunc, ComponentItem};
use wasmtime::component::{Component, ComponentExportIndex, Func, Linker, LinkerInstance, ResourceDynamic, ResourceType, Type, Val};
use wasmtime::error::Context;
use wasmtime::{bail, format_err as anyhow, Config, Engine, OptLevel, Result, Store, StoreContextMut, UpdateDeadline};

pub const TICK_MS: u64 = 10;
const TIMEOUT_MARK: &str = "zhw-timeout";

pub fn opt_level_name() -> &'static str {
    match std::env::var("ZHW_OPT").as_deref() {
        Ok("none") => "none",
        Ok("speed") => "speed",
        _ => "default",
    }
}

pub fn make_engine() -> Result<Engine> {
    let mut c = Config::new();
    c.epoch_interruption(true);
    c.wasm_component_model(true);
    match opt_level_name() {
        "none" => {
            c.cranelift_opt_level(OptLevel::None);
        }
        "speed" => {
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

fn short(iface: &str) -> String {
    iface_name(iface).trim_start_matches("zinc:plugin/").to_string()
}

fn normalize_selector(sel: &str) -> String {
    let s = sel.trim();
    if s.is_empty() {
        return String::new();
    }
    let no_ver = iface_name(s);
    let stripped = no_ver.trim_start_matches("zinc:plugin/");
    if let Some((i, f)) = stripped.split_once('.').or_else(|| stripped.split_once('#')) {
        let iname = iface_name(i);
        let iface_part = iname.trim_start_matches("zinc:plugin/");
        format!("{iface_part}.{}", kebab(f))
    } else {
        stripped.to_string()
    }
}

pub struct HostCfg {
    pub prefer_cwasm: bool,
    pub max_memory_mb: AtomicUsize,
    pub max_import_calls: AtomicU64,
    native: RwLock<HashSet<String>>,
}

impl HostCfg {
    pub fn new(prefer_cwasm: bool, max_memory_mb: usize, max_import_calls: u64, raw_native: impl IntoIterator<Item = String>) -> Self {
        let cfg = Self {
            prefer_cwasm,
            max_memory_mb: AtomicUsize::new(max_memory_mb),
            max_import_calls: AtomicU64::new(max_import_calls),
            native: RwLock::new(HashSet::new()),
        };
        cfg.set_native(raw_native);
        cfg
    }

    pub fn set_native(&self, raw: impl IntoIterator<Item = String>) {
        let mut set = self.native.write().unwrap();
        set.clear();
        for s in raw {
            let norm = normalize_selector(&s);
            if !norm.is_empty() {
                set.insert(norm);
            }
        }
    }

    pub fn matches_native(&self, short_iface: &str, kebab_fn: &str) -> bool {
        let set = self.native.read().unwrap();
        set.contains(short_iface) || set.contains(&format!("{short_iface}.{kebab_fn}"))
    }

    pub fn enabled_interfaces(&self) -> Vec<String> {
        let set = self.native.read().unwrap();
        let mut out = Vec::new();
        for &fam in NATIVE_FAMILIES {
            if set.contains(fam) {
                out.push(fam.to_string());
            }
        }
        let mut extras: Vec<String> = set
            .iter()
            .filter(|s| {
                if NATIVE_FAMILIES.contains(&s.as_str()) {
                    return false;
                }
                match s.split_once('.') {
                    Some((fam, _)) => !set.contains(fam),
                    None => true,
                }
            })
            .cloned()
            .collect();
        extras.sort();
        out.extend(extras);
        out
    }
}

pub struct Slot {
    pub id: String,
    pub dead: AtomicBool,
    pub waiting_parent: Arc<AtomicU32>,
    pub grants: Arc<RwLock<Grants>>,
    pub startup_timeout_ms: Option<u64>,
    store: tokio::sync::Mutex<Store<St>>,
    funcs: HashMap<(String, String), (Func, ComponentFunc)>,
    pub peak: Arc<AtomicUsize>,
    pub native_calls: Arc<AtomicU64>,
    pub forwarded_calls: Arc<AtomicU64>,
}

pub struct Host {
    pub engine: Engine,
    pub cfg: Arc<HostCfg>,
    pub out: Out,
    pub parent: Arc<Parent>,
    pub logs: Arc<LogManager>,
    pub prefs: Arc<PrefsManager>,
    pub app: Arc<AppManager>,
    pub l10n: Arc<L10nManager>,
    pub timers: Arc<TimerManager>,
    pub slots: Mutex<HashMap<String, Arc<Slot>>>,
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
                            li.resource_async(n, ResourceType::host_dynamic(tid), move |mut cx, rep| {
                                let di = di.clone();
                                let dn = dn.clone();
                                Box::new(async move {
                                    if !is_wasi {
                                        let remaining = cx.data().deadline_epoch.saturating_sub(now_epoch());
                                        cx.data().forwarded_calls.fetch_add(1, Ordering::Relaxed);
                                        if let Some(h) = cx.data().host.upgrade() {
                                            h.logs.flush();
                                        }
                                        let (plugin, parent, wp) = {
                                            let d = cx.data();
                                            (d.id.clone(), d.parent.clone(), d.waiting_parent.clone())
                                        };
                                        cx.data_mut().waiting += 1;
                                        wp.fetch_add(1, Ordering::Release);
                                        cx.data().send(json!({"t":"waiting","plugin":plugin,"n":cx.data().waiting}));

                                        let _ = parent
                                            .import(&plugin, &di, &format!("[resource-drop]{dn}"), vec![json!(rep as i32)])
                                            .await;

                                        cx.data_mut().waiting -= 1;
                                        wp.fetch_sub(1, Ordering::Release);
                                        cx.data().send(json!({"t":"waiting","plugin":plugin,"n":cx.data().waiting}));
                                        cx.data_mut().deadline_epoch = now_epoch() + remaining;
                                    }
                                    Ok(())
                                })
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

fn define_func(
    li: &mut LinkerInstance<'_, St>,
    iface: &str,
    fname: &str,
    cfg: Arc<HostCfg>,
    ids: Arc<HashMap<String, u32>>,
) -> Result<()> {
    let iface = iface.to_string();
    let f = fname.to_string();
    let is_wasi = iface.starts_with("wasi:");
    let sh = short(&iface);
    let fk = kebab(&f);
    let native = !is_wasi && has_native_impl(&sh, &fk) && cfg.matches_native(&sh, &fk);
    li.func_new_async(fname, move |mut cx, ty, params, results| {
        let iface = iface.clone();
        let f = f.clone();
        let sh = sh.clone();
        let fk = fk.clone();
        let ids = ids.clone();
        Box::new(async move {
            if is_wasi {
                return wasi::call(&mut cx, &iface, &f, params, results);
            }
            {
                let d = cx.data_mut();
                d.import_calls += 1;
                if d.import_calls > d.max_import_calls {
                    let max = d.max_import_calls;
                    bail!("plugin exceeded import call limit ({max})");
                }
            }
            if native {
                return crate::native::call(cx, &sh, &fk, params, results).await;
            }
            forwarded(cx, ty, &iface, &f, &ids, params, results).await
        })
    })
}

async fn forwarded(
    mut cx: StoreContextMut<'_, St>,
    ty: ComponentFunc,
    iface: &str,
    f: &str,
    ids: &HashMap<String, u32>,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let remaining = cx.data().deadline_epoch.saturating_sub(now_epoch());
    let r = forwarded_inner(&mut cx, ty, iface, f, ids, params, results).await;
    cx.data_mut().deadline_epoch = now_epoch() + remaining;
    r
}

async fn forwarded_inner(
    cx: &mut StoreContextMut<'_, St>,
    ty: ComponentFunc,
    iface: &str,
    f: &str,
    ids: &HashMap<String, u32>,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    cx.data().forwarded_calls.fetch_add(1, Ordering::Relaxed);
    let param_tys: Vec<Type> = ty.params().map(|(_, t)| t).collect();
    let mut args: Vec<Value> = params
        .iter()
        .enumerate()
        .map(|(i, p)| val_to_json_typed(&mut *cx, p, param_tys.get(i)))
        .collect::<Result<_>>()?;

    let ctor = f.strip_prefix("[constructor]").map(str::to_string);
    let mut ctor_rep = 0;
    if ctor.is_some() {
        ctor_rep = cx.data().next_rep;
        cx.data_mut().next_rep += 1;
        args.insert(0, json!(ctor_rep));
    }

    if let Some(h) = cx.data().host.upgrade() {
        h.logs.flush();
    }

    let (plugin, parent, wp) = {
        let d = cx.data();
        (d.id.clone(), d.parent.clone(), d.waiting_parent.clone())
    };
    cx.data_mut().waiting += 1;
    wp.fetch_add(1, Ordering::Release);
    cx.data().send(json!({"t":"waiting","plugin":plugin,"n":cx.data().waiting}));

    let r = parent.import(&plugin, iface, f, args).await;

    cx.data_mut().waiting -= 1;
    wp.fetch_sub(1, Ordering::Release);
    cx.data().send(json!({"t":"waiting","plugin":plugin,"n":cx.data().waiting}));

    if let Some(name) = ctor {
        let tid = *ids.get(&format!("{iface}#{name}")).ok_or_else(|| anyhow!("unknown resource {name}"))?;
        if r["ok"] != true {
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
    pub fn new(engine: Engine, cfg: Arc<HostCfg>, out: Out, parent: Arc<Parent>) -> Arc<Self> {
        Arc::new(Self {
            engine,
            cfg,
            logs: Arc::new(LogManager::new(out.clone())),
            prefs: Arc::new(PrefsManager::default()),
            app: Arc::new(AppManager::default()),
            l10n: Arc::new(L10nManager::default()),
            timers: Arc::new(TimerManager::new(out.clone())),
            out,
            parent,
            slots: Mutex::new(HashMap::new()),
        })
    }

    pub async fn load(self: &Arc<Self>, spec: &Value) -> Result<LoadInfo> {
        let id = spec["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            bail!("plugin.id is required");
        }
        let dir = PathBuf::from(spec["dir"].as_str().unwrap_or("."));
        let manifest = &spec["manifest"];
        let wasm_name = manifest["main"]["wasm"].as_str().unwrap_or("plugin.wasm");
        let wasm = dir.join(wasm_name);
        let startup_timeout_ms = manifest["main"]["startup_timeout_ms"].as_u64();

        // Cancel any previous timers if reloading the same plugin id.
        self.timers.clear_plugin(&id, false);
        self.logs.clear_plugin(&id);

        let grants = Arc::new(RwLock::new(Grants::from_json(&spec["grants"])));
        self.prefs.on_load(&id, manifest, spec.get("prefs"));
        self.l10n.on_load(&id, &dir, manifest, spec.get("l10n"), &self.logs);

        let t0 = Instant::now();
        let mut from_cwasm = false;
        let mut loaded_comp: Option<Component> = None;

        if let Some(cwasm_str) = spec.get("cwasm").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let cwasm_path = PathBuf::from(cwasm_str);
            if cwasm_path.exists() {
                // SAFETY: precompiled component in Zinc's cache folder matched by cacheKey.
                match unsafe { Component::deserialize_file(&self.engine, &cwasm_path) } {
                    Ok(c) => {
                        from_cwasm = true;
                        loaded_comp = Some(c);
                    }
                    Err(e) => {
                        self.out.send(json!({
                            "t": "log",
                            "plugin": id,
                            "level": "warn",
                            "message": format!("failed to deserialize cwasm {}: {e:#}; falling back to JIT", cwasm_path.display())
                        }));
                    }
                }
            } else {
                self.out.send(json!({
                    "t": "log",
                    "plugin": id,
                    "level": "warn",
                    "message": format!("cwasm {} missing; falling back to JIT", cwasm_path.display())
                }));
            }
        } else if self.cfg.prefer_cwasm {
            let aot_cwasm = wasm.with_extension("cwasm");
            if aot_cwasm.exists() {
                match unsafe { Component::deserialize_file(&self.engine, &aot_cwasm) } {
                    Ok(c) => {
                        from_cwasm = true;
                        loaded_comp = Some(c);
                    }
                    Err(e) => {
                        self.out.send(json!({
                            "t": "log",
                            "plugin": id,
                            "level": "warn",
                            "message": format!("failed to deserialize cwasm {}: {e:#}; falling back to JIT", aot_cwasm.display())
                        }));
                    }
                }
            }
        }

        let comp = match loaded_comp {
            Some(c) => c,
            None => Component::from_file(&self.engine, &wasm).with_context(|| format!("compile {}", wasm.display()))?,
        };
        let compile_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = Instant::now();
        let (linker, res_ids) = build_linker(&self.engine, &comp, &self.cfg)?;
        let pre = linker.instantiate_pre(&comp)?;
        let link_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let peak = Arc::new(AtomicUsize::new(0));
        let native_calls = Arc::new(AtomicU64::new(0));
        let forwarded_calls = Arc::new(AtomicU64::new(0));
        let waiting_parent = Arc::new(AtomicU32::new(0));
        let max_mem_mb = self.cfg.max_memory_mb.load(Ordering::Relaxed);
        let max_imports = self.cfg.max_import_calls.load(Ordering::Relaxed);

        let st = St {
            id: id.clone(),
            host: Arc::downgrade(self),
            limits: Limits {
                max_memory: max_mem_mb << 20,
                max_table_elems: 1_000_000,
                peak: peak.clone(),
            },
            out: self.out.clone(),
            parent: self.parent.clone(),
            res_ids,
            next_rep: 1,
            deadline_epoch: now_epoch() + ticks(15_000),
            waiting: 0,
            waiting_parent: waiting_parent.clone(),
            grants: grants.clone(),
            import_calls: 0,
            max_import_calls: max_imports,
            stdout_buf: String::new(),
            stderr_buf: String::new(),
            native_calls: native_calls.clone(),
            forwarded_calls: forwarded_calls.clone(),
        };
        let mut store = Store::new(&self.engine, st);
        store.limiter(|s| &mut s.limits);
        store.epoch_deadline_callback(|cx| {
            let d = cx.data();
            if now_epoch() >= d.deadline_epoch {
                Err(anyhow!(TIMEOUT_MARK))
            } else {
                Ok(UpdateDeadline::Yield(1))
            }
        });
        store.set_epoch_deadline(1);

        let t2 = Instant::now();
        let inst = match pre.instantiate_async(&mut store).await {
            Ok(i) => i,
            Err(e) => {
                wasi::flush_stdio(store.data_mut());
                self.logs.flush();
                return Err(e).context("instantiate");
            }
        };
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
        self.logs.flush();
        let slot = Arc::new(Slot {
            id: id.clone(),
            dead: AtomicBool::new(false),
            waiting_parent,
            grants,
            startup_timeout_ms,
            store: tokio::sync::Mutex::new(store),
            funcs,
            peak,
            native_calls,
            forwarded_calls,
        });
        self.slots.lock().unwrap().insert(id, slot);
        Ok(LoadInfo {
            compile_ms,
            link_ms,
            instantiate_ms,
            from_cwasm,
        })
    }

    pub fn unload(&self, id: &str) {
        self.timers.clear_plugin(id, false);
        self.prefs.remove_plugin(id);
        self.l10n.remove_plugin(id);
        self.logs.clear_plugin(id);
        if let Some(slot) = self.slots.lock().unwrap().remove(id) {
            if let Ok(mut guard) = slot.store.try_lock() {
                wasi::flush_stdio(guard.data_mut());
            }
        }
        self.logs.flush();
    }

    pub fn update_grants(&self, plugin: &str, grants_val: &Value) {
        let slot = self.slots.lock().unwrap().get(plugin).cloned();
        if let Some(s) = slot {
            *s.grants.write().unwrap() = Grants::from_json(grants_val);
        }
    }

    pub fn loaded_plugin_ids(&self) -> Vec<String> {
        self.slots.lock().unwrap().keys().cloned().collect()
    }

    pub async fn call_internal(
        &self,
        plugin: &str,
        iface: &str,
        f: &str,
        args: &[Value],
        timeout_ms: Option<u64>,
        max_import_calls: Option<u64>,
        from_parent: bool,
    ) -> Value {
        let slot = self.slots.lock().unwrap().get(plugin).cloned();
        let Some(slot) = slot else {
            return json!({"ok":false,"error":{"kind":"not-loaded","plugin":plugin}});
        };
        if slot.dead.load(Ordering::Relaxed) {
            return json!({"ok":false,"error":{"kind":"disabled","plugin":plugin,"reason":"the plugin trapped or timed out earlier"}});
        }
        if from_parent && slot.waiting_parent.load(Ordering::Acquire) > 0 {
            self.logs.flush();
            return json!({
                "ok": false,
                "error": {
                    "kind": "reentrant",
                    "plugin": plugin,
                    "message": "cannot call into plugin while it is waiting on a host import"
                }
            });
        }
        let sh = short(iface);
        let fk = kebab(f);
        let Some((func, fty)) = slot
            .funcs
            .get(&(sh.clone(), fk.clone()))
            .or_else(|| slot.funcs.get(&(sh.clone(), f.to_string())))
            .cloned()
        else {
            return json!({"ok":false,"error":{"kind":"no-such-export","iface":sh,"fn":camel(f)}});
        };

        let budget = timeout_ms.unwrap_or_else(|| {
            if sh == "lifecycle" && fk == "startup" {
                slot.startup_timeout_ms.unwrap_or(10_000)
            } else if sh == "lifecycle" && matches!(fk.as_str(), "install" | "shutdown" | "uninstall") {
                10_000
            } else {
                5_000
            }
        });
        let max_imports = max_import_calls.unwrap_or_else(|| self.cfg.max_import_calls.load(Ordering::Relaxed));

        let mut guard = slot.store.lock().await;
        if slot.dead.load(Ordering::Relaxed) {
            self.logs.flush();
            return json!({"ok":false,"error":{"kind":"disabled","plugin":plugin,"reason":"the plugin trapped or timed out earlier"}});
        }

        let ids = guard.data().res_ids.clone();
        let rid = ResIds { iface: "", ids: &ids };
        let mut params = Vec::new();
        for (i, (pname, pty)) in fty.params().enumerate() {
            let a = args.get(i).unwrap_or(&Value::Null);
            match json_to_val(&mut *guard, &pty, a, &rid) {
                Ok(v) => params.push(v),
                Err(e) => {
                    self.logs.flush();
                    return json!({"ok":false,"error":{"kind":"internal","message":format!("argument {pname}: {e:#}")}});
                }
            }
        }
        let rtys: Vec<Type> = fty.results().collect();
        let mut results = vec![Val::Bool(false); rtys.len()];
        let epoch = now_epoch();
        {
            let d = guard.data_mut();
            d.deadline_epoch = epoch + ticks(budget);
            d.import_calls = 0;
            d.max_import_calls = max_imports;
        }
        guard.set_epoch_deadline(1);

        let r = func.call_async(&mut *guard, &params, &mut results).await;
        match r {
            Ok(()) => {
                let out_val = match (results.first(), rtys.first()) {
                    (None, _) => json!({"ok":true,"value":null}),
                    (Some(Val::Result(Ok(p))), rty) => match p {
                        Some(p) => {
                            let ok_ty = match rty {
                                Some(Type::Result(rt)) => rt.ok(),
                                _ => None,
                            };
                            match val_to_json_typed(&mut *guard, p, ok_ty.as_ref()) {
                                Ok(v) => json!({"ok":true,"value":v}),
                                Err(e) => json!({"ok":false,"error":{"kind":"internal","message":format!("{e:#}")}}),
                            }
                        }
                        None => json!({"ok":true,"value":null}),
                    },
                    (Some(Val::Result(Err(p))), rty) => {
                        let err_ty = match rty {
                            Some(Type::Result(rt)) => rt.err(),
                            _ => None,
                        };
                        let payload = match p {
                            Some(p) => val_to_json_typed(&mut *guard, p, err_ty.as_ref()).unwrap_or(Value::Null),
                            None => Value::Null,
                        };
                        json!({"ok":false,"error":{"kind":"wit","payload":payload}})
                    }
                    (Some(v), rty) => match val_to_json_typed(&mut *guard, v, rty) {
                        Ok(v) => json!({"ok":true,"value":v}),
                        Err(e) => json!({"ok":false,"error":{"kind":"internal","message":format!("{e:#}")}}),
                    },
                };
                self.logs.flush();
                out_val
            }
            Err(e) => {
                let msg = format!("{e:#}");
                wasi::flush_stdio(guard.data_mut());
                self.logs.flush();
                slot.dead.store(true, Ordering::Relaxed);
                self.timers.clear_plugin(plugin, false);
                let is_timeout = msg.contains(TIMEOUT_MARK);
                let kind = if is_timeout { "timeout" } else { "trap" };
                let error = if is_timeout {
                    json!({"kind":"timeout","ms":budget,"phase":format!("{sh}#{fk}")})
                } else {
                    json!({"kind":"trap","message":msg})
                };
                let note = if is_timeout {
                    format!("timed out after {budget} ms in {sh}#{fk}")
                } else {
                    msg
                };
                self.out.send(json!({
                    "t": "plugin-exit",
                    "plugin": plugin,
                    "kind": kind,
                    "message": note
                }));
                json!({"ok":false,"error":error})
            }
        }
    }

    pub fn stats(&self) -> Value {
        let slots = self.slots.lock().unwrap();
        let v: Vec<Value> = slots
            .values()
            .map(|s| {
                let fwd = s.forwarded_calls.load(Ordering::Relaxed);
                json!({
                    "plugin": s.id,
                    "peakMemoryBytes": s.peak.load(Ordering::Relaxed),
                    "dead": s.dead.load(Ordering::Relaxed),
                    "nativeCalls": s.native_calls.load(Ordering::Relaxed),
                    "forwardedCalls": fwd,
                    "bridgedCalls": fwd,
                    "activeTimers": self.timers.count(&s.id),
                })
            })
            .collect();
        json!({
            "rssBytes": crate::rss_bytes(),
            "plugins": v,
        })
    }
}
