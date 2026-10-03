package tech.ugolok.pushprobe

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object ProbeLog {
    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS", Locale.US)

    private fun logFile(context: Context): File {
        val dir = context.getExternalFilesDir(null) ?: context.filesDir
        return File(dir, "probe-log.txt")
    }

    @Synchronized
    fun append(context: Context, text: String) {
        val now = System.currentTimeMillis()
        val line = "epoch_ms=$now iso=${isoFormat.format(Date(now))} $text\n"
        logFile(context).appendText(line)
    }

    fun readTail(context: Context, maxLines: Int = 200): String {
        val file = logFile(context)
        if (!file.exists()) return "(лог пуст)"
        val lines = file.readLines()
        return lines.takeLast(maxLines).joinToString("\n")
    }

    fun path(context: Context): String = logFile(context).absolutePath
}
