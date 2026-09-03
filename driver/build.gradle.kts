plugins {
    id("com.android.application") version "8.7.3"
    kotlin("android") version "2.0.21"
}

/**
 * The simcheck multi-touch driver.
 *
 * There is no app here worth speaking of -- the whole payload is the
 * androidTest APK, which UiAutomator runs with shell privileges so it can
 * inject input into whatever else is on screen. The main APK exists only
 * because an instrumentation must name a target package.
 */
android {
    namespace = "com.simcheck.driver"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.simcheck.driver"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        // Debug only: the driver is never shipped anywhere, and a release
        // build would want signing config the harness has no business holding.
        getByName("debug") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("junit:junit:4.13.2")
}
