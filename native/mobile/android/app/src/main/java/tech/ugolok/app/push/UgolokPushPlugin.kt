package tech.ugolok.app.push

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

// Э-PUSH (TZ-PUSH-ANDROID.md, П2.5) — методы вызываются ТОЛЬКО из
// src/platform/capacitor.js (§4.2, единственная точка входа @capacitor/*
// на JS-стороне). Сам сервис (UgolokPushService) делает всю сетевую и
// уведомительную работу — этот класс только мост вызовов + состояние
// "включена ли функция" (SharedPreferences, переживает перезапуск процесса,
// нужно PushBootReceiver'у, П2.2).
@CapacitorPlugin(name = "UgolokPush")
class UgolokPushPlugin : Plugin() {

    companion object {
        const val EXTRA_ROUTE = "ugolok_push_route"
        const val ROUTE_MESSAGE = "message"
        const val ROUTE_CALL = "call"

        private const val PREFS = "ugolok_push_prefs"
        private const val PREF_ENABLED = "enabled"

        fun isEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_ENABLED, false)
    }

    private fun prefs(): SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun load() {
        super.load()
        // Холодный старт по нажатию на push-уведомление (П3.6: если процесс был
        // завершён ОС, это первый и единственный шанс узнать route — Activity
        // ещё не существовала, чтобы поймать onNewIntent).
        consumeRouteFromIntent(activity?.intent)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        consumeRouteFromIntent(intent)
    }

    private fun consumeRouteFromIntent(intent: Intent?) {
        val route = intent?.getStringExtra(EXTRA_ROUTE) ?: return
        intent.removeExtra(EXTRA_ROUTE) // не разослать тот же route повторно при следующем onNewIntent/resume
        val data = JSObject()
        data.put("route", route)
        notifyListeners("pushOpen", data)
    }

    @PluginMethod
    fun enable(call: PluginCall) {
        prefs().edit().putBoolean(PREF_ENABLED, true).apply()
        // Намеренно НЕ стартуем службу здесь без топиков — setTopics() сделает
        // это сама, как только JS-сторона закончит регистрацию на мосту
        // (П3.2: enable() -> POST /push/register за каждый аккаунт -> setTopics()).
        call.resolve()
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        prefs().edit().putBoolean(PREF_ENABLED, false).apply()
        val intent = Intent(context, UgolokPushService::class.java).setAction(UgolokPushService.ACTION_STOP)
        context.startService(intent)
        call.resolve()
    }

    // setTopics([{accountId, endpoint}]) — П2.1 «мультиаккаунт — один топик на
    // аккаунт». Пустой список — то же самое, что disable() для самого сервиса
    // (нечего слушать), но НЕ трогает флаг PREF_ENABLED — отличие от полного
    // disable(): пользователь мог просто выйти из единственного аккаунта,
    // функция остаётся включённой на будущее.
    @PluginMethod
    fun setTopics(call: PluginCall) {
        val topics = call.getArray("topics") ?: JSONArray()
        if (topics.length() == 0 || !isEnabled(context)) {
            context.startService(Intent(context, UgolokPushService::class.java).setAction(UgolokPushService.ACTION_STOP))
            call.resolve()
            return
        }
        val intent = Intent(context, UgolokPushService::class.java)
            .setAction(UgolokPushService.ACTION_START)
            .putExtra(UgolokPushService.EXTRA_TOPICS_JSON, topics.toString())
        androidx.core.content.ContextCompat.startForegroundService(context, intent)
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val result = JSObject()
        result.put("running", UgolokPushService.isRunning)
        result.put("batteryExempt", isBatteryExempt())
        result.put("fullScreenAllowed", isFullScreenAllowed())
        result.put("notificationsAllowed", NotificationManagerCompat.from(context).areNotificationsEnabled())
        val lastConnectedAt = UgolokPushService.lastConnectedAt(context)
        result.put("lastConnectedAt", lastConnectedAt ?: JSONObject.NULL)
        call.resolve(result)
    }

    private fun isBatteryExempt(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun isFullScreenAllowed(): Boolean {
        if (Build.VERSION.SDK_INT < 34) return true
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        return nm.canUseFullScreenIntent()
    }

    // Прямой системный диалог "исключить это приложение из оптимизации
    // батареи?" — не список настроек (для того есть общий APPLICATION_DETAILS_
    // SETTINGS, который ниже используют openAutostartSettings как fallback).
    // Требует REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (П2.6) — допустимо для
    // дистрибуции без Google Play (основное ТЗ В8).
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (e: Exception) {
            openAppDetailsSettings()
        }
        call.resolve()
    }

    // OEM-специфичные экраны "автозапуска"/"фоновой активности" (П2.5/П3.4:
    // Xiaomi/HyperOS, Huawei, Samsung, Oppo/Realme/OnePlus, Vivo). Живой тест
    // П0.4 (PUSH-E0-REPORT.md) на OPPO Reno 15 Pro Max (ColorOS) подтвердил,
    // что именно ЭТОТ класс настройки, не общая "battery optimization",
    // реально решает проблему разрыва соединения на этой прошивке — экран
    // называется "Управление энергопотреблением приложений", доступ к нему
    // штатно идёт через ACTION_APPLICATION_DETAILS_SETTINGS (ColorOS кладёт
    // свою карточку энергопотребления на экран деталей приложения, отдельного
    // публичного intent-action для него нет). Для Xiaomi/Huawei/Vivo —
    // отдельные MAIN/ComponentName-интенты с известными классами (задокументированы
    // сообществом, dontkillmyapp.com), КАЖДЫЙ в своём try/catch: если конкретная
    // прошивка/версия не отвечает на конкретный intent, падаем на следующий
    // вариант вплоть до общего экрана деталей приложения, который есть всегда.
    @PluginMethod
    fun openAutostartSettings(call: PluginCall) {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val candidates = mutableListOf<Intent>()

        when {
            manufacturer.contains("xiaomi") -> {
                candidates.add(componentIntent("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
            }
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> {
                candidates.add(componentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"))
                candidates.add(componentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"))
            }
            manufacturer.contains("oppo") || manufacturer.contains("realme") || manufacturer.contains("oneplus") -> {
                // ColorOS/OxygenOS — живьём подтверждено (см. комментарий выше):
                // нужный тумблер живёт на экране деталей приложения, не в
                // отдельном экране "автозапуска" системного диспетчера.
                candidates.add(componentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"))
                candidates.add(componentIntent("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"))
            }
            manufacturer.contains("vivo") -> {
                candidates.add(componentIntent("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"))
            }
            manufacturer.contains("samsung") -> {
                // Samsung держит это внутри "Battery" -> "Background usage limits",
                // отдельного публичного deep-link intent под конкретное приложение
                // нет (сообщество подтверждает то же самое) — сразу общий экран.
            }
        }

        for (intent in candidates) {
            try {
                context.startActivity(intent)
                call.resolve()
                return
            } catch (e: Exception) {
                // конкретная прошивка/версия не отвечает на этот intent — пробуем
                // следующий кандидат, а не сдаёмся сразу
            }
        }
        openAppDetailsSettings()
        call.resolve()
    }

    private fun componentIntent(pkg: String, cls: String): Intent {
        val intent = Intent()
        intent.component = android.content.ComponentName(pkg, cls)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return intent
    }

    private fun openAppDetailsSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    @PluginMethod
    fun requestFullScreenPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (e: Exception) {
                openAppDetailsSettings()
            }
        }
        // < 34 — разрешение выдаётся автоматически вместе с USE_FULL_SCREEN_INTENT
        // в манифесте, отдельного экрана нет и просить нечего.
        call.resolve()
    }
}
