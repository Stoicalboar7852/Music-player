plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.phosphor.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.phosphor.android"
        // Android 10: playback capture (hearing other apps) arrived then.
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "3.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
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
    buildFeatures {
        buildConfig = true
    }
}

// The web app goes in assets/ (built by `npm run android:web`); without it the app would be empty.
val checkWebApp by tasks.registering {
    doLast {
        if (!file("src/main/assets/index.html").exists()) {
            throw GradleException("The web app isn't built into the Android app yet: run `npm run android:web` in the repository first.")
        }
    }
}
tasks.named("preBuild") { dependsOn(checkWebApp) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
}
