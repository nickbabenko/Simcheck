package com.simcheck.driver

import android.app.Instrumentation
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.MotionEvent.PointerCoords
import android.view.MotionEvent.PointerProperties
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test

/**
 * Multi-touch for simcheck.
 *
 * `adb shell input` drives exactly one pointer, so pinch, two-finger pan and a
 * genuine double tap cannot be expressed through it. An instrumentation can:
 * it runs with shell privileges and may inject input into any app, not only
 * one it owns. This class is that injection, parameterised over
 * `am instrument -e` arguments so the harness drives one gesture per call.
 *
 * MotionEvents are assembled here rather than through UiAutomator's
 * `performMultiPointerGesture`, which hangs off UiObject and therefore needs a
 * selector for some element -- an awkward dependency for a driver whose whole
 * point is to work against any app, including one whose tree it has not read.
 * Building the event stream directly also makes the timing explicit, and
 * timing is what separates a gesture from a teleport.
 *
 * It deliberately holds no assertions. The verdict belongs to whatever the
 * harness observes afterwards; this only performs the gesture.
 */
class Touch {

    private val args: Bundle = InstrumentationRegistry.getArguments()
    private val instrumentation: Instrumentation = InstrumentationRegistry.getInstrumentation()

    private data class P(val x: Float, val y: Float)

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
        instrumentation.waitForIdleSync()
    }

    /**
     * Two contacts moving along a line through (cx, cy), from one separation
     * to another. Spreading zooms in, closing zooms out.
     */
    private fun pinch() {
        val cx = num("cx")
        val cy = num("cy")
        val start = num("startSpread")
        val end = num("endSpread")
        val duration = numOr("durationMs", 600f)

        gesture(duration) { t ->
            val gap = lerp(start, end, t)
            listOf(P(cx - gap / 2f, cy), P(cx + gap / 2f, cy))
        }
    }

    /** Two contacts travelling in parallel -- a map drag, a two-finger scroll. */
    private fun pan() {
        val startX = num("startX")
        val startY = num("startY")
        val endX = num("endX")
        val endY = num("endY")
        val gap = numOr("gap", 80f)
        val duration = numOr("durationMs", 600f)

        gesture(duration) { t ->
            val x = lerp(startX, endX, t)
            val y = lerp(startY, endY, t)
            listOf(P(x - gap / 2f, y), P(x + gap / 2f, y))
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
        val hold = numOr("holdMs", 800f)

        gesture(hold) { listOf(P(cx - gap / 2f, cy), P(cx + gap / 2f, cy)) }
    }

    /**
     * A real double tap, so a double-tap gesture recogniser actually fires.
     *
     * Two independent taps would carry no timing guarantee. It is the second
     * DOWN landing inside the platform's double-tap window that makes this a
     * double tap rather than two taps, so the spacing is explicit.
     */
    private fun doubleTap() {
        val x = num("x")
        val y = num("y")
        tap(x, y)
        SystemClock.sleep(80)
        tap(x, y)
    }

    private fun tap(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        val props = arrayOf(pointerProperties(0))
        val coords = arrayOf(pointerCoords(x, y))
        inject(down, down, MotionEvent.ACTION_DOWN, props, coords)
        inject(down, down + 40, MotionEvent.ACTION_UP, props, coords)
    }

    /**
     * Drive N contacts through a path, as one continuous gesture.
     *
     * The event sequence a recogniser expects: the first pointer DOWN, each
     * later one POINTER_DOWN carrying its index, a stream of MOVEs, then the
     * pointers lifted in reverse. Getting the index shift wrong here produces
     * events the system silently drops, which is why it is spelled out.
     */
    private fun gesture(durationMs: Float, at: (Float) -> List<P>) {
        val steps = (durationMs / 16f).toInt().coerceIn(8, 200)
        val interval = (durationMs / steps).toLong().coerceAtLeast(1L)
        val first = at(0f)
        val count = first.size
        require(count in 1..10) { "simcheck driver: $count contacts is not a gesture" }

        val downTime = SystemClock.uptimeMillis()
        val props = Array(count) { pointerProperties(it) }
        val coords = Array(count) { pointerCoords(first[it].x, first[it].y) }

        // First contact lands, then each additional one in turn.
        inject(downTime, downTime, MotionEvent.ACTION_DOWN, props.copyOfRange(0, 1), coords.copyOfRange(0, 1))
        for (i in 1 until count) {
            val action = MotionEvent.ACTION_POINTER_DOWN or
                (i shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            inject(downTime, SystemClock.uptimeMillis(), action, props.copyOfRange(0, i + 1), coords.copyOfRange(0, i + 1))
        }

        for (step in 1..steps) {
            val t = step.toFloat() / steps
            val points = at(t)
            for (i in 0 until count) {
                coords[i].x = points[i].x
                coords[i].y = points[i].y
            }
            SystemClock.sleep(interval)
            inject(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, props, coords)
        }

        // Lift in reverse, so the pointer indices stay valid as they go.
        for (i in count - 1 downTo 1) {
            val action = MotionEvent.ACTION_POINTER_UP or
                (i shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            inject(downTime, SystemClock.uptimeMillis(), action, props.copyOfRange(0, i + 1), coords.copyOfRange(0, i + 1))
        }
        inject(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, props.copyOfRange(0, 1), coords.copyOfRange(0, 1))
    }

    private fun pointerProperties(index: Int): PointerProperties =
        PointerProperties().apply {
            id = index
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }

    private fun pointerCoords(x: Float, y: Float): PointerCoords =
        PointerCoords().apply {
            this.x = x
            this.y = y
            pressure = 1f
            size = 1f
        }

    private fun inject(
        downTime: Long, eventTime: Long, action: Int,
        props: Array<PointerProperties>, coords: Array<PointerCoords>,
    ) {
        val event = MotionEvent.obtain(
            downTime, eventTime, action, props.size, props, coords,
            0, 0, 1f, 1f, 0, 0,
            InputDevice.SOURCE_TOUCHSCREEN, 0,
        )
        try {
            // Synchronous: the next event must not be built until this one has
            // been dispatched, or the stream arrives out of order.
            check(instrumentation.uiAutomation.injectInputEvent(event, true)) {
                "simcheck driver: the system rejected a MotionEvent (action $action)"
            }
        } finally {
            event.recycle()
        }
    }

    private fun lerp(from: Float, to: Float, t: Float): Float = from + (to - from) * t
}
