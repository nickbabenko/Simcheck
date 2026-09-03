package com.simcheck.driver

import android.app.Instrumentation
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.MotionEvent.PointerCoords
import android.view.MotionEvent.PointerProperties
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Test

/**
 * Multi-touch for simcheck.
 *
 * `adb shell input` drives exactly one pointer, so pinch, two-finger pan and a
 * genuine double tap cannot be expressed through it. UiAutomator can: an
 * instrumentation runs with shell privileges and may inject input into any
 * app, not only one it owns. This class is that injection, parameterised over
 * `am instrument -e` arguments so the harness can drive one gesture per call.
 *
 * It deliberately holds no assertions. The verdict belongs to whatever the
 * harness observes afterwards; this only performs the gesture.
 */
class Touch {

    private val args: Bundle = InstrumentationRegistry.getArguments()
    private val instrumentation: Instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device: UiDevice = UiDevice.getInstance(instrumentation)

    private fun arg(name: String): String =
        args.getString(name) ?: error("simcheck driver: missing required argument \"$name\"")

    private fun num(name: String): Float = arg(name).toFloat()

    private fun numOr(name: String, fallback: Float): Float =
        args.getString(name)?.toFloatOrNull() ?: fallback

    @Test
    fun perform() {
        when (val action = arg("action")) {
            "pinch" -> pinch()
            "pan" -> pan()
            "two_finger_press" -> twoFingerPress()
            "double_tap" -> doubleTap()
            else -> error("simcheck driver: unknown action \"$action\"")
        }
    }

    /**
     * Two contacts moving along a line through (cx, cy), from one separation
     * to another. Spreading zooms in, closing zooms out.
     */
    private fun pinch() {
        val cx = num("cx")
        val cy = num("cy")
        val startSpread = num("startSpread")
        val endSpread = num("endSpread")
        val steps = stepsFor(numOr("durationMs", 600f))

        // Along the horizontal axis: the axis matters less than that both
        // contacts move symmetrically about the centre.
        val first = path(steps) { t ->
            val gap = lerp(startSpread, endSpread, t)
            PointF(cx - gap / 2f, cy)
        }
        val second = path(steps) { t ->
            val gap = lerp(startSpread, endSpread, t)
            PointF(cx + gap / 2f, cy)
        }
        require(device.performMultiPointerGesture(first, second)) {
            "simcheck driver: the pinch gesture was not accepted"
        }
    }

    /** Two contacts travelling in parallel -- a map drag, a two-finger scroll. */
    private fun pan() {
        val startX = num("startX")
        val startY = num("startY")
        val endX = num("endX")
        val endY = num("endY")
        val gap = numOr("gap", 80f)
        val steps = stepsFor(numOr("durationMs", 600f))

        val first = path(steps) { t ->
            PointF(lerp(startX, endX, t) - gap / 2f, lerp(startY, endY, t))
        }
        val second = path(steps) { t ->
            PointF(lerp(startX, endX, t) + gap / 2f, lerp(startY, endY, t))
        }
        require(device.performMultiPointerGesture(first, second)) {
            "simcheck driver: the pan gesture was not accepted"
        }
    }

    /**
     * Two fingers placed and held, with no travel at all.
     *
     * The point is the landing itself: a spreading pinch confounds "the app
     * zoomed because I spread" with "the app zoomed the instant a second
     * contact appeared". Holding still separates the two.
     */
    private fun twoFingerPress() {
        val cx = num("cx")
        val cy = num("cy")
        val gap = numOr("gap", 90f)
        val holdMs = numOr("holdMs", 800f)
        val steps = stepsFor(holdMs)

        val first = path(steps) { PointF(cx - gap / 2f, cy) }
        val second = path(steps) { PointF(cx + gap / 2f, cy) }
        require(device.performMultiPointerGesture(first, second)) {
            "simcheck driver: the two-finger press was not accepted"
        }
    }

    /**
     * A real double tap, so a double-tap gesture recogniser actually fires.
     *
     * Two `click` calls would be two independent gestures with no guaranteed
     * spacing. Injecting the MotionEvents directly lets the second DOWN carry
     * a timestamp inside the platform's double-tap window, which is the only
     * thing that makes it a double tap rather than two taps.
     */
    private fun doubleTap() {
        val x = num("x")
        val y = num("y")
        tap(x, y)
        SystemClock.sleep(80)
        tap(x, y)
        instrumentation.waitForIdleSync()
    }

    private fun tap(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, down, down, x, y)
        inject(MotionEvent.ACTION_UP, down, down + 40, x, y)
    }

    private fun inject(action: Int, downTime: Long, eventTime: Long, x: Float, y: Float) {
        val properties = arrayOf(PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        })
        val coords = arrayOf(PointerCoords().apply {
            this.x = x
            this.y = y
            pressure = 1f
            size = 1f
        })
        val event = MotionEvent.obtain(
            downTime, eventTime, action, 1, properties, coords,
            0, 0, 1f, 1f, 0, 0,
            android.view.InputDevice.SOURCE_TOUCHSCREEN, 0,
        )
        try {
            instrumentation.uiAutomation.injectInputEvent(event, true)
        } finally {
            event.recycle()
        }
    }

    /* ------------------------------------------------------------ helpers */

    private data class PointF(val x: Float, val y: Float)

    private fun lerp(from: Float, to: Float, t: Float): Float = from + (to - from) * t

    /** Enough intermediate points that a recogniser sees a smooth drag, not a
     *  teleport, without flooding the input pipeline. */
    private fun stepsFor(durationMs: Float): Int =
        (durationMs / 16f).toInt().coerceIn(8, 120)

    private fun path(steps: Int, at: (Float) -> PointF): Array<PointerCoords> =
        Array(steps) { i ->
            val point = at(if (steps == 1) 0f else i.toFloat() / (steps - 1))
            PointerCoords().apply {
                x = point.x
                y = point.y
                pressure = 1f
                size = 1f
            }
        }
}
