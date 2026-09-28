package tech.ugolok.app;

import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Э4.10 ТЗ-NATIVE-APPS — "ui.setSecureScreen(true) (запрет скриншотов и
// превью в списке задач) на время показа мнемоники". FLAG_SECURE не имеет
// готового API ни в @capacitor/core (в отличие от SystemBars), ни в виде
// официального first-party плагина под Capacitor 8 — собственный минимальный
// plugin, тот же класс решения, что ТЗ уже предвидит для Э6.4 ("небольшой
// собственный плагин на Kotlin"); здесь Java — тот же принцип, что уже
// используется в MainActivity.java (Э4.7's WindowInsets listener).
@CapacitorPlugin(name = "SecureScreen")
public class SecureScreenPlugin extends Plugin {
	@PluginMethod
	public void setEnabled(PluginCall call) {
		boolean enabled = call.getBoolean("enabled", false);
		getActivity()
			.runOnUiThread(() -> {
				if (enabled) {
					getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
				} else {
					getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
				}
			});
		call.resolve();
	}
}
