package tech.ugolok.app.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.lifecycle.ProcessLifecycleOwner
import org.json.JSONArray
import org.json.JSONObject
import tech.ugolok.app.MainActivity
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

// Э-PUSH (TZ-PUSH-ANDROID.md, П2.1) — foreground-service типа connectedDevice
// (решение П0.5, PUSH-E0-REPORT.md), держит РОВНО ОДНО SSE-соединение к ntfy
// на ВСЕ зарегистрированные топики разом — ntfy поддерживает подписку на
// несколько топиков через запятую в одном URL (.../topicA,topicB/sse), это
// подтверждено официальной документацией при проектировании (не домысел);
// каждое входящее сообщение несёт поле "topic" — по нему сервис узнаёт, какому
// аккаунту оно адресовано. Сетевая часть (чтение построчно, keepalive от ntfy
// раз в ~45с без своего дополнительного пинга — П0.6, реконнект по таймауту
// чтения) — тот же код, что уже живьём проверен на реальном телефоне владельца
// в native/push-probe-android/ProbeService.kt (П0.4), расширенный на
// мультитопик + реальную категоризацию push (m/c) вместо лога.
class UgolokPushService : Service() {

    companion object {
        const val ACTION_START = "tech.ugolok.app.push.START"
        const val ACTION_STOP = "tech.ugolok.app.push.STOP"
        const val EXTRA_TOPICS_JSON = "topics_json"

        private const val CHANNEL_MESSAGES = "push_messages"
        private const val CHANNEL_CALLS = "push_calls"
        private const val CHANNEL_BACKGROUND = "push_background"

        private const val STATUS_NOTIF_ID = 9001
        private const val MESSAGE_NOTIF_ID = 9002 // П2.4: один и тот же id — повторные push заменяют, не плодят новые
        private const val CALL_NOTIF_ID = 9003

        // RING_TIMEOUT из src/domain/calls/call-fsm.js (30000мс) — то же значение,
        // синхронизированное вручную, что уже использует agent/internal/pushbridge/
        // coalesce.go::CallSessionGap на стороне моста. Нет автосвязи Kotlin↔JS↔Go
        // между модулями сборки — если таймер звонка когда-нибудь изменят,
        // здесь тоже нужно поправить руками.
        private const val CALL_RING_TIMEOUT_MS = 30_000L

        private const val MIN_BACKOFF_MS = 2_000L
        private const val MAX_BACKOFF_MS = 60_000L
        // П0.6: дефолтный интервал keepalive ntfy (~45с) пережил 30+ минут
        // полной неподвижности без единого разрыва (живой тест, PUSH-E0-REPORT.md).
        // 120с даёт запас в 2.5x на случай худшей сети, не полагаясь на точное
        // совпадение с измеренным интервалом.
        private const val READ_TIMEOUT_MS = 120_000

        private const val PREFS = "ugolok_push_prefs"
        private const val PREF_TOPICS_JSON = "topics_json"
        private const val PREF_LAST_CONNECTED_AT = "last_connected_at"

        // Состояние для UgolokPushPlugin.status() (П2.5) — читается синхронно с
        // JS-стороны через PluginCall, поэтому просто статические поля процесса,
        // не межпроцессный IPC: сервис и плагин всегда в одном процессе приложения.
        @Volatile
        var isRunning: Boolean = false
            private set

        fun lastConnectedAt(context: Context): Long? {
            val v = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(PREF_LAST_CONNECTED_AT, -1L)
            return if (v > 0) v else null
        }

        fun currentTopicsJson(context: Context): String? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_TOPICS_JSON, null)
    }

    private data class PushTopic(val accountId: String, val topic: String, val endpoint: String)

    private val running = AtomicBoolean(false)
    private var workerThread: Thread? = null
    private var topics: List<PushTopic> = emptyList()
    private lateinit var prefs: SharedPreferences
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val reconnectLock = Object()
    @Volatile private var reconnectRequested = false

    // П2.4 «m → если интерфейс приложения сейчас на экране — ничего не
    // показывать». ProcessLifecycleOwner — состояние ВСЕГО процесса приложения
    // (не одной Activity), верно даже если WebView открыт в другой задаче/окне.
    private val isAppForeground: Boolean
        get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)

    override fun onCreate() {
        super.onCreate()
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }

        val topicsJson = intent?.getStringExtra(EXTRA_TOPICS_JSON) ?: prefs.getString(PREF_TOPICS_JSON, null)
        if (topicsJson.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        val parsed = parseTopics(topicsJson)
        if (parsed.isEmpty()) {
            stopEverything()
            return START_NOT_STICKY
        }
        topics = parsed
        prefs.edit().putString(PREF_TOPICS_JSON, topicsJson).apply()

        if (running.compareAndSet(false, true)) {
            isRunning = true
            startForeground(STATUS_NOTIF_ID, buildStatusNotification("подключение…"))
            registerNetworkCallback()
            startWorker()
        } else {
            // топики поменялись у уже работающего сервиса (вступление/выход из
            // группы, смена аккаунта) — не пересоздаём процесс, будим воркер,
            // он перечитает this.topics на следующей итерации reconnect-цикла.
            triggerReconnect()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    private fun stopEverything() {
        val wasRunning = running.getAndSet(false)
        isRunning = false
        unregisterNetworkCallback()
        if (wasRunning) {
            workerThread?.interrupt()
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun triggerReconnect() {
        synchronized(reconnectLock) {
            reconnectRequested = true
            reconnectLock.notifyAll()
        }
    }

    // «Реакция на смену сети» (П2.1) — активный разрыв старого соединения при
    // потере/смене сети произойдёт сам (readTimeout/IOException), но ждать до
    // 120с таймаута чтения после того, как сеть УЖЕ вернулась — нужная задержка
    // отзывчивости, которую можно убрать: как только onAvailable, будим воркер
    // немедленно вместо того, чтобы ждать естественного разрыва.
    private fun registerNetworkCallback() {
        val cm = connectivityManager ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                triggerReconnect()
            }
        }
        try {
            cm.registerNetworkCallback(request, callback)
            networkCallback = callback
        } catch (e: Exception) {
            // некоторые OEM-прошивки режут это разрешение/API — не критично,
            // просто не будет проактивного реконнекта, пассивный (по таймауту
            // чтения) всё ещё работает.
        }
    }

    private fun unregisterNetworkCallback() {
        val cb = networkCallback ?: return
        try {
            connectivityManager?.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            // сервис уже мог быть в процессе уничтожения ОС — не фатально
        }
        networkCallback = null
    }

    private fun startWorker() {
        workerThread = Thread {
            var attempt = 0
            while (running.get()) {
                attempt++
                try {
                    connectAndRead(::onEvent)
                    attempt = 0 // успешное (хоть и завершившееся) соединение — сброс нарастающей паузы
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    // тихо: сеть нестабильна по определению на мобильном устройстве,
                    // это не ошибка приложения — реконнект ниже сам всё восстановит.
                }
                if (!running.get()) break
                val backoff = minOf(MIN_BACKOFF_MS * (1L shl minOf(attempt, 6)), MAX_BACKOFF_MS)
                updateStatusNotification("переподключение…")
                waitForReconnect(backoff)
            }
        }
        workerThread?.isDaemon = true
        workerThread?.start()
    }

    private fun waitForReconnect(timeoutMs: Long) {
        synchronized(reconnectLock) {
            if (reconnectRequested) {
                reconnectRequested = false
                return
            }
            try {
                reconnectLock.wait(timeoutMs)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            reconnectRequested = false
        }
    }

    // Анти-дубликат звонков — тот же приём (скользящее окно сессии), что
    // agent/internal/pushbridge/coalesce.go::ShouldPush на стороне моста
    // (PUSH-P1-REPORT.md, решение 3): каждое "c"-событие сдвигает окно,
    // push-уведомление показывается только на событие, начинающее новую
    // сессию. Здесь это ВТОРОЙ независимый уровень защиты (мост уже
    // склеивает на своей стороне) — на случай прямого повторного визита в
    // приложение без пересоздания топика или гонки доставки.
    @Volatile private var lastCallEventAt = 0L

    private fun isNewCallSession(now: Long): Boolean {
        val isNew = (now - lastCallEventAt) >= CALL_RING_TIMEOUT_MS
        lastCallEventAt = now
        return isNew
    }

    private fun connectAndRead(onEvent: (JSONObject) -> Unit) {
        val current = topics
        if (current.isEmpty()) return
        val base = current.first().endpoint.substringBeforeLast("/")
        val combinedTopics = current.joinToString(",") { it.topic }
        val url = URL("$base/$combinedTopics/sse")

        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.connectTimeout = 15_000
        conn.readTimeout = READ_TIMEOUT_MS
        conn.doInput = true
        conn.connect()

        if (conn.responseCode != 200) {
            conn.disconnect()
            return
        }

        prefs.edit().putLong(PREF_LAST_CONNECTED_AT, System.currentTimeMillis()).apply()
        updateStatusNotification("на связи")

        BufferedReader(InputStreamReader(conn.inputStream)).use { reader ->
            while (running.get()) {
                val line = reader.readLine() ?: break
                if (!line.startsWith("data:")) continue
                val json = line.removePrefix("data:").trim()
                if (json.isEmpty()) continue
                try {
                    val obj = JSONObject(json)
                    if (obj.optString("event") == "message") onEvent(obj)
                } catch (e: Exception) {
                    // строка не JSON/битый keepalive-комментарий — пропускаем, не рвём поток
                }
            }
        }
        conn.disconnect()
    }

    private fun onEvent(msg: JSONObject) {
        val topic = msg.optString("topic")
        val body = msg.optString("message") // ИП1: ровно "m" или "c", ничего больше — не проверяем содержимое сверх этого
        val match = topics.find { it.topic == topic } ?: return

        when (body) {
            "m" -> {
                if (!isAppForeground) showMessageNotification()
            }
            "c" -> {
                if (isNewCallSession(System.currentTimeMillis())) {
                    showCallNotification(match.accountId)
                }
            }
        }
    }

    // --- Уведомления (П2.3/П2.4) ---

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_DEFAULT))

        val callChannel = NotificationChannel(CHANNEL_CALLS, "Звонки", NotificationManager.IMPORTANCE_HIGH)
        val ringtone = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
        if (ringtone != null) {
            callChannel.setSound(
                ringtone,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
        }
        nm.createNotificationChannel(callChannel)

        nm.createNotificationChannel(NotificationChannel(CHANNEL_BACKGROUND, "Фоновая связь", NotificationManager.IMPORTANCE_MIN))
    }

    private fun openAppIntent(route: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (route != null) putExtra(UgolokPushPlugin.EXTRA_ROUTE, route)
        }
        return PendingIntent.getActivity(this, route?.hashCode() ?: 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun buildStatusNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_BACKGROUND)
            .setContentTitle("Уголок на связи")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(openAppIntent(null))
            .build()

    private fun updateStatusNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(STATUS_NOTIF_ID, buildStatusNotification(text))
    }

    // П2.4 «m»: без отправителя и текста (В1) — заменяет, не плодит (фикс. id).
    // Заголовок нейтральный, не "Новое сообщение" — "m" приходит и для заявок
    // в контакты/канал (тот же p-тег gift wrap, push-мост не может их
    // различить, см. matcher.go), конкретная формулировка была бы неточной.
    private fun showMessageNotification() {
        val notif = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setContentTitle("Новое уведомление")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(UgolokPushPlugin.ROUTE_MESSAGE))
            .build()
        getSystemService(NotificationManager::class.java).notify(MESSAGE_NOTIF_ID, notif)
    }

    private fun showCallNotification(accountId: String) {
        val nm = getSystemService(NotificationManager::class.java)
        val openIntent = openAppIntent(UgolokPushPlugin.ROUTE_CALL)
        val dismissIntent = PendingIntent.getBroadcast(
            this, CALL_NOTIF_ID,
            Intent(this, PushDismissReceiver::class.java).putExtra(PushDismissReceiver.EXTRA_NOTIF_ID, CALL_NOTIF_ID),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val fullScreenAllowed = nm.areNotificationsEnabled() &&
            (android.os.Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent())

        val builder = NotificationCompat.Builder(this, CHANNEL_CALLS)
            .setContentTitle("Уголок — Вам звонят")
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setTimeoutAfter(CALL_RING_TIMEOUT_MS)
            .setContentIntent(openIntent)
            .addAction(0, "Открыть", openIntent)
            .addAction(0, "Отклонить", dismissIntent)

        // Разрешение на полноэкранные уведомления может быть отозвано (Android
        // 14+, П2.4) — тогда обычное высокоприоритетное уведомление со звуком
        // (уже даёт CHANNEL_CALLS), не полноэкранный intent.
        if (fullScreenAllowed) {
            builder.setFullScreenIntent(openIntent, true)
        }

        nm.notify(CALL_NOTIF_ID, builder.build())
    }

    private fun parseTopics(json: String): List<PushTopic> {
        return try {
            val arr = JSONArray(json)
            (0 until arr.length()).mapNotNull { i ->
                val obj = arr.getJSONObject(i)
                val endpoint = obj.optString("endpoint")
                val accountId = obj.optString("accountId")
                val topic = Uri.parse(endpoint).lastPathSegment
                if (endpoint.isBlank() || accountId.isBlank() || topic.isNullOrBlank()) null
                else PushTopic(accountId, topic, endpoint)
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
