package com.simcheck.demo

import android.graphics.Bitmap
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.clearText
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.typeText
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Android counterpart of DemoAppUITests.
 *
 * These exist to prove the harness's instrumentation mode end to end, so they
 * assert things a screenshot genuinely cannot settle -- that the counter holds
 * the right number, that toggling actually rewrote the status text -- rather
 * than restating what a captured frame already shows.
 */
@RunWith(AndroidJUnit4::class)
class DemoInstrumentedTest {

    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    private fun signIn() {
        onView(withId(R.id.email_field)).perform(clearText(), typeText("demo@example.com"))
        onView(withId(R.id.password_field)).perform(clearText(), typeText("hunter2"), closeSoftKeyboard())
        onView(withId(R.id.sign_in_button)).perform(click())
    }

    @Test
    fun signInRejectsRubbish() {
        onView(withId(R.id.email_field)).perform(clearText(), typeText("nope"))
        onView(withId(R.id.password_field)).perform(clearText(), typeText("x"), closeSoftKeyboard())
        onView(withId(R.id.sign_in_button)).perform(click())
        onView(withId(R.id.login_error)).check(matches(isDisplayed()))
    }

    @Test
    fun counterCountsClicks() {
        signIn()
        onView(withId(R.id.counter_tab)).perform(click())
        repeat(3) { onView(withId(R.id.increment_button)).perform(click()) }
        // The point of an instrumentation test: the value, not its appearance.
        onView(withId(R.id.count_label)).check(matches(withText("3")))
    }

    @Test
    fun togglingBetaRewritesTheStatus() {
        signIn()
        onView(withId(R.id.settings_tab)).perform(click())
        onView(withId(R.id.beta_toggle)).perform(click())
        onView(withId(R.id.beta_status)).check(matches(withText("Beta features are ON")))
        captureInto("beta-on")

        onView(withId(R.id.beta_toggle)).perform(click())
        onView(withId(R.id.beta_status)).check(matches(withText("Beta features are OFF")))
    }

    /**
     * Save a screenshot where the harness will collect it.
     *
     * `additionalTestOutputDir` is the argument the harness passes and then
     * pulls from afterwards, so anything written here comes back as an
     * attachment on the run. Done with plain file IO and UiAutomation rather
     * than a test-storage dependency, to keep this example's build small.
     */
    private fun captureInto(name: String) {
        val dir = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")
            ?: return
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            ?: return
        File(dir).mkdirs()
        File(dir, "$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
