package tech.ugolok.pushprobe

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import kotlin.random.Random

class MainActivity : AppCompatActivity() {

    private lateinit var topicInput: EditText
    private lateinit var statusText: TextView
    private lateinit var logText: TextView

    private val notifPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> startProbe() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        topicInput = findViewById(R.id.topicInput)
        statusText = findViewById(R.id.statusText)
        logText = findViewById(R.id.logText)
        findViewById<TextView>(R.id.logPathText).text = "Лог-файл: ${ProbeLog.path(this)}"

        val prefs = getSharedPreferences("push_probe_prefs", MODE_PRIVATE)
        topicInput.setText(
            prefs.getString("topic", null) ?: "ugolok-probe-" + Random.nextInt(100000, 999999)
        )

        findViewById<Button>(R.id.startButton).setOnClickListener {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                startProbe()
            }
        }

        findViewById<Button>(R.id.stopButton).setOnClickListener {
            val intent = Intent(this, ProbeService::class.java).setAction(ProbeService.ACTION_STOP)
            startService(intent)
            statusText.text = "Статус: остановлен"
        }

        findViewById<Button>(R.id.refreshButton).setOnClickListener { refreshLog() }

        refreshLog()
    }

    override fun onResume() {
        super.onResume()
        refreshLog()
    }

    private fun startProbe() {
        val topic = topicInput.text.toString().trim()
        if (topic.isEmpty()) return
        val intent = Intent(this, ProbeService::class.java)
            .setAction(ProbeService.ACTION_START)
            .putExtra(ProbeService.EXTRA_TOPIC, topic)
        ContextCompat.startForegroundService(this, intent)
        statusText.text = "Статус: запущен, топик=$topic\nURL для проверки: https://ntfy.sh/$topic\ncurl -d \"текст\" https://ntfy.sh/$topic"
    }

    private fun refreshLog() {
        logText.text = ProbeLog.readTail(this)
    }
}
