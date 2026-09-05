plugins {
    id("com.android.application")
    kotlin("android")
}

/**
 * Deliberately minimal: plain Android views, no Compose, no AppCompat.
 *
 * The app itself has zero dependencies, so a first build is fast and the
 * harness's Gradle path is exercised without waiting on a large dependency
 * graph. Every control carries a stable `android:id`, which is what the
 * harness matches when a step targets `id`.
 */
android {
    namespace = "com.simcheck.demo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.simcheck.demo"
        // DayNight themes, so the `appearance` step visibly changes the app
        // rather than only the system.
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        getByName("debug") { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
