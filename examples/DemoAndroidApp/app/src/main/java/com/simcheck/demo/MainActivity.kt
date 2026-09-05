package com.simcheck.demo

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import android.widget.ViewFlipper

/**
 * A deliberately small app with the shapes a test scenario needs: a login
 * gate, two tabs, a form control that changes visible state, and a counter.
 *
 * It is the Android counterpart of examples/DemoApp, and uses the same
 * identifiers on purpose -- the same step list should drive either platform,
 * which is the clearest way to show that the harness speaks one vocabulary.
 */
class MainActivity : Activity() {

    private var count = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val root = findViewById<ViewFlipper>(R.id.root_flipper)
        val email = findViewById<EditText>(R.id.email_field)
        val password = findViewById<EditText>(R.id.password_field)
        val error = findViewById<TextView>(R.id.login_error)

        findViewById<Button>(R.id.sign_in_button).setOnClickListener {
            val ok = email.text.contains("@") && password.text.length >= 4
            if (ok) {
                error.visibility = TextView.GONE
                root.displayedChild = 1
            } else {
                error.text = "Enter a valid email and a password of at least 4 characters"
                error.visibility = TextView.VISIBLE
            }
        }

        val counterPane = findViewById<View>(R.id.counter_pane)
        val settingsPane = findViewById<View>(R.id.settings_pane)
        fun showTab(settings: Boolean) {
            counterPane.visibility = if (settings) View.GONE else View.VISIBLE
            settingsPane.visibility = if (settings) View.VISIBLE else View.GONE
        }
        findViewById<Button>(R.id.counter_tab).setOnClickListener { showTab(false) }
        findViewById<Button>(R.id.settings_tab).setOnClickListener { showTab(true) }

        val countLabel = findViewById<TextView>(R.id.count_label)
        findViewById<Button>(R.id.increment_button).setOnClickListener {
            count += 1
            countLabel.text = count.toString()
        }

        val status = findViewById<TextView>(R.id.beta_status)
        findViewById<Switch>(R.id.beta_toggle).setOnCheckedChangeListener { _, on ->
            status.text = if (on) "Beta features are ON" else "Beta features are OFF"
        }
    }
}
