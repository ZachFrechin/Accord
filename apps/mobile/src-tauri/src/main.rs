// Sur Android, le point d'entrée est la bibliothèque (`mobile_entry_point`) ;
// ce binaire n'existe que pour permettre un `cargo run` de vérification.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    accord_mobile_lib::run()
}
