// Э3 ТЗ-NATIVE-APPS — оболочка desktop-приложения (Windows/macOS/Linux).
// Всё платформенно-зависимое поведение здесь — конфигурация плагинов,
// трей, меню, окно; сама логика приложения (весь src/) грузится как
// frontendDist (dist-tauri, см. vite.config.js/tauri.conf.json) и общается
// с системой через src/platform/tauri.js (JS-стороной этих же плагинов).
use tauri::{
	menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
	tray::TrayIconBuilder,
	Manager, WindowEvent,
};

// Э3.6 — "Открыть"/"Выход" в меню трея; клик по самой иконке трея тоже
// показывает окно (частый паттерн, не требует отдельного пункта меню).
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
	let open_i = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
	let quit_i = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
	let menu = Menu::with_items(app, &[&open_i, &quit_i])?;
	TrayIconBuilder::new()
		.icon(app.default_window_icon().unwrap().clone())
		.menu(&menu)
		.show_menu_on_left_click(false)
		.on_menu_event(|app, event| match event.id.as_ref() {
			"open" => show_main_window(app),
			"quit" => app.exit(0),
			_ => {}
		})
		.on_tray_icon_event(|tray, event| {
			if let tauri::tray::TrayIconEvent::Click {
				button: tauri::tray::MouseButton::Left,
				button_state: tauri::tray::MouseButtonState::Up,
				..
			} = event
			{
				show_main_window(tray.app_handle());
			}
		})
		.build(app)?;
	Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
	if let Some(w) = app.get_webview_window("main") {
		let _ = w.show();
		let _ = w.set_focus();
	}
}

// Э3.5 — Edit-меню ОБЯЗАТЕЛЬНО на macOS, иначе в WKWebView не работают
// системные Cmd+C/V/X/A/Z (нет своего контекстного меню у веб-контента,
// эти шорткаты приходят ТОЛЬКО через нативное меню приложения — T20,
// E0-REPORT.md). Window-меню — тоже предопределённые пункты (Cmd+M и т.д.).
#[cfg(target_os = "macos")]
fn set_macos_menu(app: &tauri::App) -> tauri::Result<()> {
	let app_menu = Submenu::with_items(
		app,
		"Уголок",
		true,
		&[
			&PredefinedMenuItem::about(app, None, None)?,
			&PredefinedMenuItem::separator(app)?,
			&PredefinedMenuItem::hide(app, None)?,
			&PredefinedMenuItem::hide_others(app, None)?,
			&PredefinedMenuItem::show_all(app, None)?,
			&PredefinedMenuItem::separator(app)?,
			&PredefinedMenuItem::quit(app, None)?,
		],
	)?;
	let edit_menu = Submenu::with_items(
		app,
		"Edit",
		true,
		&[
			&PredefinedMenuItem::undo(app, None)?,
			&PredefinedMenuItem::redo(app, None)?,
			&PredefinedMenuItem::separator(app)?,
			&PredefinedMenuItem::cut(app, None)?,
			&PredefinedMenuItem::copy(app, None)?,
			&PredefinedMenuItem::paste(app, None)?,
			&PredefinedMenuItem::select_all(app, None)?,
		],
	)?;
	let window_menu = Submenu::with_items(
		app,
		"Window",
		true,
		&[
			&PredefinedMenuItem::minimize(app, None)?,
			&PredefinedMenuItem::maximize(app, None)?,
			&PredefinedMenuItem::separator(app)?,
			&PredefinedMenuItem::close_window(app, None)?,
		],
	)?;
	let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
	app.set_menu(menu)?;
	Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let mut builder = tauri::Builder::default();

	// Single-instance (И9) — ОБЯЗАН регистрироваться первым плагином
	// (документированное требование tauri-plugin-single-instance):
	// повторный запуск не открывает второе окно поверх той же IndexedDB
	// с MLS-состоянием, а просто фокусирует уже открытое.
	#[cfg(desktop)]
	{
		builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
			show_main_window(app);
		}));
	}

	builder = builder
		// Э3.4 — окно помнит позицию/размер между запусками.
		.plugin(tauri_plugin_window_state::Builder::default().build())
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_opener::init())
		.setup(|app| {
			if cfg!(debug_assertions) {
				app.handle().plugin(
					tauri_plugin_log::Builder::default()
						.level(log::LevelFilter::Info)
						.build(),
				)?;
			}
			build_tray(app)?;
			#[cfg(target_os = "macos")]
			set_macos_menu(app)?;
			Ok(())
		})
		// Э3.6 — закрытие окна прячет его в трей вместо выхода; выход —
		// только через пункт "Выход" в меню трея (build_tray). Дефолт
		// "включено" (см. ТЗ) — настройка-переключатель в UI приложения
		// пока не подключена (см. PROGRESS.md, Э3).
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { api, .. } = event {
				let _ = window.hide();
				api.prevent_close();
			}
		});

	builder
		.run(tauri::generate_context!())
		.expect("error while building tauri application");
}
