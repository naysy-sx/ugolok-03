package tech.ugolok.app.push

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// П2.4 «Отклонить» на уведомлении входящего звонка — просто убирает
// уведомление локально (отклонить звонок протокольно без ключа невозможно —
// у звонящего сработает обычный таймаут, ТЗ буквально).
class PushDismissReceiver : BroadcastReceiver() {
    companion object {
        const val EXTRA_NOTIF_ID = "notif_id"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_NOTIF_ID, -1)
        if (id != -1) {
            context.getSystemService(NotificationManager::class.java).cancel(id)
        }
    }
}
