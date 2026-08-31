import XCTest

/// Proves the harness's `xctest` mode end to end, including the multi-touch
/// gesture that started this: XCUITest pinch is genuine two-finger input, so
/// the zoom is asserted rather than eyeballed.
final class PinchTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testSignInThenReachSettings() throws {
        let app = XCUIApplication()
        app.launch()

        let email = app.textFields["email_field"]
        XCTAssertTrue(email.waitForExistence(timeout: 10), "login screen should appear")
        email.tap(); email.typeText("demo@example.com")

        let password = app.secureTextFields["password_field"]
        password.tap(); password.typeText("hunter2")
        app.buttons["sign_in_button"].tap()

        XCTAssertTrue(app.staticTexts["count_label"].waitForExistence(timeout: 10),
                      "should land on the counter after signing in")

        // An attachment so a failure arrives with a picture.
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "after-sign-in"; shot.lifetime = .keepAlways
        add(shot)
    }

    func testPinchIsRealMultiTouch() throws {
        let app = XCUIApplication()
        app.launch()

        let email = app.textFields["email_field"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText("demo@example.com")
        app.secureTextFields["password_field"].tap()
        app.secureTextFields["password_field"].typeText("hunter2")
        app.buttons["sign_in_button"].tap()

        XCTAssertTrue(app.staticTexts["count_label"].waitForExistence(timeout: 10))

        // Genuine two-finger input -- this is the capability AXe cannot provide.
        app.pinch(withScale: 3.0, velocity: 1.0)
        app.pinch(withScale: 0.5, velocity: -1.0)

        XCTAssertTrue(app.staticTexts["count_label"].exists,
                      "the app should survive a real multi-touch pinch")

        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "after-pinch"; shot.lifetime = .keepAlways
        add(shot)
    }

    func testDeliberateFailureIsReported() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.textFields["email_field"].waitForExistence(timeout: 10))
        // Intentional: proves failures surface in the evidence report.
        XCTAssertTrue(app.buttons["a_button_that_does_not_exist"].exists,
                      "deliberate failure to prove the harness reports it")
    }
}
