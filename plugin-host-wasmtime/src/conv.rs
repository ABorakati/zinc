//! Component `Val` <-> JSON, in the shape jco uses for JS (what `plugin-host/src/imports/*` handlers expect):
//! kebab names are camelCase, `u64`/`s64` are `{"$big":"123"}` (BigInt on the Bun side), `list<u8>` is `{"$bytes":"<base64>"}`,
//! `option<T>` is the value or JSON null, records are objects, variants are `{"tag":"case","val":..}`, enums are strings, flags are
//! objects of booleans, resources are the handle number (or the `{"$zinc-resource": name, id}` marker coming back).
use wasmtime::error::Context;
use wasmtime::{format_err as anyhow, bail, Result};
use base64::Engine as _;
use serde_json::{json, Map, Value};
use wasmtime::component::{ResourceDynamic, Type, Val};
use wasmtime::AsContextMut;

pub fn camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = false;
    for c in s.chars() {
        if c == '-' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

pub fn kebab(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut prev_lower = false;
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            if prev_lower {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
            prev_lower = false;
        } else {
            out.push(c);
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        }
    }
    out
}

/// "zinc:plugin/prefs@0.1.0" -> "zinc:plugin/prefs".
pub fn iface_name(name: &str) -> String {
    match name.rfind('@') {
        Some(i) => name[..i].to_string(),
        None => name.to_string(),
    }
}

pub fn val_to_json(cx: &mut impl AsContextMut, v: &Val) -> Result<Value> {
    Ok(match v {
        Val::Bool(b) => json!(b),
        Val::S8(n) => json!(n),
        Val::U8(n) => json!(n),
        Val::S16(n) => json!(n),
        Val::U16(n) => json!(n),
        Val::S32(n) => json!(n),
        Val::U32(n) => json!(n),
        Val::S64(n) => json!({ "$big": n.to_string() }),
        Val::U64(n) => json!({ "$big": n.to_string() }),
        Val::Float32(f) => serde_json::Number::from_f64(*f as f64).map(Value::Number).unwrap_or(Value::Null),
        Val::Float64(f) => serde_json::Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
        Val::Char(c) => Value::String(c.to_string()),
        Val::String(s) => Value::String(s.clone()),
        Val::List(items) => {
            if !items.is_empty() && items.iter().all(|i| matches!(i, Val::U8(_))) {
                let bytes: Vec<u8> = items.iter().map(|i| if let Val::U8(b) = i { *b } else { 0 }).collect();
                json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes) })
            } else {
                Value::Array(items.iter().map(|i| val_to_json(cx, i)).collect::<Result<_>>()?)
            }
        }
        Val::FixedLengthList(items) | Val::Tuple(items) => Value::Array(items.iter().map(|i| val_to_json(cx, i)).collect::<Result<_>>()?),
        Val::Map(kv) => Value::Array(kv.iter().map(|(k, v)| Ok(json!([val_to_json(cx, k)?, val_to_json(cx, v)?]))).collect::<Result<_>>()?),
        Val::Record(fields) => {
            let mut m = Map::new();
            for (name, val) in fields {
                let j = val_to_json(cx, val)?;
                if !j.is_null() {
                    m.insert(camel(name), j);
                }
            }
            Value::Object(m)
        }
        Val::Variant(name, payload) => {
            let mut m = Map::new();
            m.insert("tag".into(), Value::String(name.clone()));
            if let Some(p) = payload {
                m.insert("val".into(), val_to_json(cx, p)?);
            }
            Value::Object(m)
        }
        Val::Enum(s) => Value::String(s.clone()),
        Val::Option(None) => Value::Null,
        Val::Option(Some(x)) => val_to_json(cx, x)?,
        Val::Result(r) => {
            let (tag, p) = match r {
                Ok(p) => ("ok", p),
                Err(p) => ("err", p),
            };
            let mut m = Map::new();
            m.insert("tag".into(), json!(tag));
            if let Some(p) = p {
                m.insert("val".into(), val_to_json(cx, p)?);
            }
            Value::Object(m)
        }
        Val::Flags(names) => Value::Object(names.iter().map(|n| (camel(n), Value::Bool(true))).collect()),
        Val::Resource(ra) => {
            let r = ResourceDynamic::try_from_resource_any(*ra, cx.as_context_mut()).context("not a host resource")?;
            json!(r.rep() as i32)
        }
        other => bail!("unsupported value kind in import call: {other:?}"),
    })
}

fn num_i(j: &Value) -> Result<i64> {
    match j {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).ok_or_else(|| anyhow!("bad number {n}")),
        Value::Object(o) => o.get("$big").and_then(|b| b.as_str()).ok_or_else(|| anyhow!("expected integer, got {j}"))?.parse::<i64>().map_err(Into::into),
        Value::String(s) => Ok(s.parse()?),
        Value::Bool(b) => Ok(*b as i64),
        _ => bail!("expected integer, got {j}"),
    }
}

fn num_u(j: &Value) -> Result<u64> {
    match j {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)).ok_or_else(|| anyhow!("bad number {n}")),
        Value::Object(o) => o.get("$big").and_then(|b| b.as_str()).ok_or_else(|| anyhow!("expected integer, got {j}"))?.parse::<u64>().map_err(Into::into),
        Value::String(s) => Ok(s.parse()?),
        _ => bail!("expected unsigned integer, got {j}"),
    }
}

/// Context needed to rebuild resource handles: the host-dynamic type id per `iface#resource`.
pub struct ResIds<'a> {
    pub iface: &'a str,
    pub ids: &'a std::collections::HashMap<String, u32>,
}

pub fn json_to_val(cx: &mut impl AsContextMut, ty: &Type, j: &Value, res: &ResIds) -> Result<Val> {
    Ok(match ty {
        Type::Bool => Val::Bool(j.as_bool().ok_or_else(|| anyhow!("expected bool, got {j}"))?),
        Type::S8 => Val::S8(num_i(j)? as i8),
        Type::U8 => Val::U8(num_u(j)? as u8),
        Type::S16 => Val::S16(num_i(j)? as i16),
        Type::U16 => Val::U16(num_u(j)? as u16),
        Type::S32 => Val::S32(num_i(j)? as i32),
        Type::U32 => Val::U32(num_u(j)? as u32),
        Type::S64 => Val::S64(num_i(j)?),
        Type::U64 => Val::U64(num_u(j)?),
        Type::Float32 => Val::Float32(j.as_f64().unwrap_or(f64::NAN) as f32),
        Type::Float64 => Val::Float64(j.as_f64().unwrap_or(f64::NAN)),
        Type::Char => Val::Char(j.as_str().and_then(|s| s.chars().next()).ok_or_else(|| anyhow!("expected char"))?),
        Type::String => Val::String(j.as_str().ok_or_else(|| anyhow!("expected string, got {j}"))?.to_string()),
        Type::List(l) => {
            let et = l.ty();
            if let (Type::U8, Some(b)) = (&et, j.get("$bytes").and_then(|b| b.as_str())) {
                let bytes = base64::engine::general_purpose::STANDARD.decode(b)?;
                Val::List(bytes.into_iter().map(Val::U8).collect())
            } else {
                let arr = j.as_array().ok_or_else(|| anyhow!("expected list, got {j}"))?;
                Val::List(arr.iter().map(|x| json_to_val(cx, &et, x, res)).collect::<Result<_>>()?)
            }
        }
        Type::Record(r) => {
            let obj = j.as_object().ok_or_else(|| anyhow!("expected record, got {j}"))?;
            let mut out = Vec::new();
            for f in r.fields() {
                let v = obj.get(&camel(f.name)).or_else(|| obj.get(f.name)).unwrap_or(&Value::Null);
                out.push((f.name.to_string(), json_to_val(cx, &f.ty, v, res).with_context(|| format!("field {}", f.name))?));
            }
            Val::Record(out)
        }
        Type::Tuple(t) => {
            let arr = j.as_array().ok_or_else(|| anyhow!("expected tuple, got {j}"))?;
            Val::Tuple(t.types().zip(arr).map(|(t, x)| json_to_val(cx, &t, x, res)).collect::<Result<_>>()?)
        }
        Type::Variant(v) => {
            let tag = j.get("tag").and_then(|t| t.as_str()).ok_or_else(|| anyhow!("expected variant {{tag,val}}, got {j}"))?;
            let case = v.cases().find(|c| c.name == tag || camel(c.name) == tag).ok_or_else(|| anyhow!("unknown variant case {tag}"))?;
            let payload = match case.ty {
                Some(t) => Some(Box::new(json_to_val(cx, &t, j.get("val").unwrap_or(&Value::Null), res)?)),
                None => None,
            };
            Val::Variant(case.name.to_string(), payload)
        }
        Type::Enum(e) => {
            let s = j.as_str().ok_or_else(|| anyhow!("expected enum string, got {j}"))?;
            let name = e.names().find(|n| *n == s || camel(n) == s).ok_or_else(|| anyhow!("unknown enum case {s}"))?;
            Val::Enum(name.to_string())
        }
        Type::Option(o) => {
            if j.is_null() {
                Val::Option(None)
            } else {
                Val::Option(Some(Box::new(json_to_val(cx, &o.ty(), j, res)?)))
            }
        }
        Type::Result(r) => {
            let tag = j.get("tag").and_then(|t| t.as_str()).unwrap_or("ok");
            let (side, t) = if tag == "err" { (false, r.err()) } else { (true, r.ok()) };
            let p = match t {
                Some(t) => Some(Box::new(json_to_val(cx, &t, j.get("val").unwrap_or(&Value::Null), res)?)),
                None => None,
            };
            Val::Result(if side { Ok(p) } else { Err(p) })
        }
        Type::Flags(f) => {
            let obj = j.as_object().ok_or_else(|| anyhow!("expected flags object"))?;
            Val::Flags(f.names().filter(|n| obj.get(&camel(n)).and_then(|v| v.as_bool()).unwrap_or(false)).map(str::to_string).collect())
        }
        Type::Own(_) | Type::Borrow(_) => {
            let name = j.get("$zinc-resource").and_then(|n| n.as_str()).ok_or_else(|| anyhow!("expected resource marker, got {j}"))?;
            let id = j.get("id").and_then(|n| n.as_i64()).ok_or_else(|| anyhow!("resource marker without id"))?;
            let tid = *res.ids.get(&format!("{}#{}", res.iface, name)).ok_or_else(|| anyhow!("unknown resource {name}"))?;
            Val::Resource(ResourceDynamic::new_own(id as i32 as u32, tid).try_into_resource_any(cx.as_context_mut())?)
        }
        other => bail!("unsupported type in import result: {other:?}"),
    })
}

/// Default value of a type, used when a plugin's expected result is missing.
pub fn unit_result_ok() -> Val {
    Val::Result(Ok(None))
}
