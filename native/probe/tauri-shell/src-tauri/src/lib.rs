#[tauri::command]
fn probe_report(app: tauri::AppHandle, json: String) {
  println!("PROBE_RESULT_BEGIN\n{}\nPROBE_RESULT_END", json);
  // В CI (PROBE_AUTOEXIT=1) окно некому закрыть руками — выходим сами после отчёта.
  if std::env::var("PROBE_AUTOEXIT").is_ok() {
    app.exit(0);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![probe_report])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
