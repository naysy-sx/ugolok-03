package tech.ugolok.pushprobe

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ProbeService : Service() {

    companion object {
        const val ACTION_START = "tech.ugolok.pushprobe.START"
        const val ACTION_STOP = "tech.ugolok.pushprobe.STOP"
        const val EXTRA_TOPIC = "topic"

        private const val STATUS_CHANNEL = "probe_status"
        private const val EVENT_CHANNEL = "probe_event"
        private const val STATUS_NOTIF_ID = 1
        private const val PREFS = "push_probe_prefs"
        private const val PREF_TOPIC = "topic"

        // ntfy читает keepalive/сообщения без явного таймаута с нашей стороны —
        // если за это время не пришло ни строки (даже keepalive), считаем соединение
        // тихо оборвавшимся и переподключаемся (сам факт разрыва тоже логируется —
        // это данные для П0.6).
        private const val READ_TIMEOUT_MS = 120_000
        private const val RECONNECT_BACKOFF_MS = 3_000L
    }

    private val running = AtomicBoolean(false)
    private val eventCounter = AtomicInteger(0)
    private var workerThread: Thread? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        if (intent?.action == ACTION_STOP) {
            stopProbe()
            return START_NOT_STICKY
        }

        val topic = intent?.getStringExtra(EXTRA_TOPIC) ?: prefs.getString(PREF_TOPIC, null)
        if (topic.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        prefs.edit().putString(PREF_TOPIC, topic).apply()

        if (running.get()) {
            return START_STICKY
        }

        startForeground(STATUS_NOTIF_ID, buildStatusNotification("подключение…"))
        ProbeLog.append(applicationContext, "service_start topic=$topic")
        startWorker(topic, prefs)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopProbe()
        super.onDestroy()
    }

    private fun stopProbe() {
        val wasRunning = running.getAndSet(false)
        if (wasRunning) {
            ProbeLog.append(applicationContext, "service_stop")
            workerThread?.interrupt()
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startWorker(topic: String, prefs: SharedPreferences) {
        running.set(true)
        workerThread = Thread {
            var attempt = 0
            while (running.get()) {
                attempt++
                try {
                    connectAndRead(topic)
                } catch (e: InterruptedException) {
                    break
                } catch (e: Exception) {
                    ProbeLog.append(applicationContext, "stream_error attempt=$attempt msg=${e.message}")
                }
                if (!running.get()) break
                updateStatusNotification("переподключение (попытка ${attempt + 1})…")
                try {
                    Thread.sleep(RECONNECT_BACKOFF_MS)
                } catch (e: InterruptedException) {
                    break
                }
            }
        }
        workerThread?.isDaemon = true
        workerThread?.start()
    }

    private fun connectAndRead(topic: String) {
        val url = URL("https://ntfy.sh/$topic/sse")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.connectTimeout = 15_000
        conn.readTimeout = READ_TIMEOUT_MS
        conn.doInput = true

        ProbeLog.append(applicationContext, "connecting topic=$topic net=${activeNetworkSummary()}")
        conn.connect()

        if (conn.responseCode != 200) {
            ProbeLog.append(applicationContext, "connect_failed http=${conn.responseCode}")
            conn.disconnect()
            return
        }

        updateStatusNotification("подключено, слушаю топик")
        ProbeLog.append(applicationContext, "connected topic=$topic")

        BufferedReader(InputStreamReader(conn.inputStream)).use { reader ->
            var line: String?
            while (running.get()) {
                line = reader.readLine() ?: break
                if (!line.startsWith("data:")) continue
                val json = line.removePrefix("data:").trim()
                if (json.isEmpty()) continue
                handleEvent(json)
            }
        }
        conn.disconnect()
        ProbeLog.append(applicationContext, "stream_closed topic=$topic")
    }

    private fun handleEvent(rawJson: String) {
        val obj = try {
            JSONObject(rawJson)
        } catch (e: Exception) {
            ProbeLog.append(applicationContext, "parse_error raw=$rawJson")
            return
        }
        when (obj.optString("event")) {
            "open" -> ProbeLog.append(applicationContext, "event=open")
            "keepalive" -> ProbeLog.append(applicationContext, "event=keepalive")
            "message" -> {
                val n = eventCounter.incrementAndGet()
                val body = obj.optString("message", "")
                val ntfyId = obj.optString("id", "")
                val serverTime = obj.optLong("time", 0L)
                ProbeLog.append(
                    applicationContext,
                    "event=message seq=$n ntfy_id=$ntfyId server_time_s=$serverTime body=\"$body\""
                )
                showEventNotification(n, body)
            }
            else -> ProbeLog.append(applicationContext, "event=other raw=$rawJson")
        }
    }

    private fun activeNetworkSummary(): String {
        return try {
            val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            when {
                caps == null -> "none"
                caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                else -> "other"
            }
        } catch (e: Exception) {
            "unknown"
        }
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(STATUS_CHANNEL, "Статус зонда", NotificationManager.IMPORTANCE_LOW)
        )
        nm.createNotificationChannel(
            NotificationChannel(EVENT_CHANNEL, "Полученные пуши", NotificationManager.IMPORTANCE_HIGH)
        )
    }

    private fun buildStatusNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, STATUS_CHANNEL)
            .setContentTitle("Push Probe активен")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .build()
    }

    private fun updateStatusNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(STATUS_NOTIF_ID, buildStatusNotification(text))
    }

    private fun showEventNotification(seq: Int, body: String) {
        val nm = getSystemService(NotificationManager::class.java)
        val notif = NotificationCompat.Builder(this, EVENT_CHANNEL)
            .setContentTitle("Пуш #$seq получен")
            .setContentText(body.ifBlank { "(без текста)" })
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        nm.notify(1000 + seq, notif)
    }
}
