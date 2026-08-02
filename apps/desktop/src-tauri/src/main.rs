// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Desktop entry point. The real wiring (window runtime + secure-storage
/// commands) lives in the library crate so it can be shared with the mobile
/// entry point.
fn main() {
    accord_desktop_lib::run();
}
