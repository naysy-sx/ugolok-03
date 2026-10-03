package tech.ugolok.app.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

// П2.2 «Автозапуск: после перезагрузки (RECEIVE_BOOT_COMPLETED), если функция
// включена; после обновления приложения». Оба события — ACTION_BOOT_COMPLETED
// и ACTION_MY_PACKAGE_REPLACED — покрыты одним receiver'ом, тот же набор
// условий на запуск.
//
// connectedDevice (тип FGS, П0.5) НЕ входит в список типов, которым Android 15+
// запрещает стартовать из BOOT_COMPLETED (запрещены dataSync/camera/
// mediaPlayback/phoneCall/mediaProjection/microphone/specialUse — проверено
// перед написанием этого файла, не домысел) — прямой startForegroundService()
// здесь безопасен.
class PushBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!UgolokPushPlugin.isEnabled(context)) return
        val topicsJson = UgolokPushService.currentTopicsJson(context) ?: return

        val serviceIntent = Intent(context, UgolokPushService::class.java)
            .setAction(UgolokPushService.ACTION_START)
            .putExtra(UgolokPushService.EXTRA_TOPICS_JSON, topicsJson)
        ContextCompat.startForegroundService(context, serviceIntent)
    }
}
