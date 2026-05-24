#![no_main]
//! Fuzz the ZeroClaw config parser AND its validation chain.
//!
//! Previously this target just round-tripped arbitrary bytes through
//! `toml::from_str::<toml::Value>` — it exercised the toml crate's
//! tokenizer, not ZeroClaw's surface. Now:
//!   1. Parse the input as TOML (cheap; rejects most random bytes).
//!   2. Deserialize into the real `zeroclaw::Config` shape — exercises
//!      the layered `#[serde(default)]` defaults, custom
//!      `deserialize_with` hooks (reasoning_effort_opt, etc.), and
//!      every enum tag the real config accepts.
//!   3. Call `Config::validate()` — exercises the post-deser checks
//!      that catch cross-field invariants (provider × model
//!      consistency, temperature bounds, nodes auth requirements).
//!
//! Crash = bug in ZeroClaw's parser / validator. Errors are expected
//! for malformed input; we discard them silently.
use libfuzzer_sys::fuzz_target;
use zeroclaw::Config;

fuzz_target!(|data: &[u8]| {
    let Ok(s) = std::str::from_utf8(data) else {
        return;
    };
    // First gate: TOML must tokenise. Cheap; rejects ~all random bytes.
    let Ok(_raw_value) = toml::from_str::<toml::Value>(s) else {
        return;
    };
    // Second gate: shape into the real Config. This drives the serde
    // deserialize path — custom deserializers, default fillers, enum
    // tag dispatch all exercise here. Panics during deserialize are
    // the bug class we're hunting.
    let Ok(cfg) = toml::from_str::<Config>(s) else {
        return;
    };
    // Third gate: validate. cross-field invariants and lint rules.
    // We don't care WHETHER it validates — we care that validate()
    // doesn't panic on any input the deserializer accepted.
    let _ = cfg.validate();
});
