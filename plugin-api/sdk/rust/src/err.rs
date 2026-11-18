//! Errors. `Error` is `types.error`; these are the short constructors.

pub use crate::host::types::Error;

pub fn not_found(m: impl Into<String>) -> Error {
    Error::NotFound(m.into())
}
pub fn invalid(m: impl Into<String>) -> Error {
    Error::InvalidArgument(m.into())
}
pub fn denied(m: impl Into<String>) -> Error {
    Error::PermissionDenied(m.into())
}
pub fn unavailable(m: impl Into<String>) -> Error {
    Error::Unavailable(m.into())
}
pub fn internal(m: impl Into<String>) -> Error {
    Error::Internal(m.into())
}

/// Anything printable becomes `error::internal`. Handy with `?`-less code: `.map_err(err::from_display)`.
pub fn from_display(e: impl core::fmt::Display) -> Error {
    Error::Internal(e.to_string())
}

/// The text of an error, for logs and toasts.
pub fn message(e: &Error) -> String {
    match e {
        Error::NotFound(m) => format!("not found: {m}"),
        Error::InvalidArgument(m) => format!("invalid argument: {m}"),
        Error::PermissionDenied(m) => format!("permission denied: {m}"),
        Error::ReadOnly(m) => format!("read only: {m}"),
        Error::Conflict(m) => format!("conflict: {m}"),
        Error::LimitExceeded(m) => format!("limit exceeded: {m}"),
        Error::Timeout => "timeout".into(),
        Error::Cancelled => "cancelled".into(),
        Error::Unavailable(m) => format!("unavailable: {m}"),
        Error::Internal(m) => format!("internal: {m}"),
    }
}

/// `library.apply` fails with an `apply-error` (which change, which error). Flatten it.
#[cfg(feature = "library")]
pub fn from_apply(e: crate::host::library::ApplyError) -> Error {
    match e.index {
        Some(i) => from_display(format!("change {i}: {}", message(&e.error))),
        None => e.error,
    }
}
