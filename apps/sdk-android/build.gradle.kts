// SPDX-License-Identifier: MIT

plugins {
    id("com.android.library") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "1.9.25"
    jacoco
}

group = "io.confeature"
version = "0.1.0"

android {
    namespace = "io.confeature.android"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
        // `targetSdk` belongs on the library so consumers inherit the
        // tested target; Android Lint flags missing targetSdk otherwise.
        @Suppress("DEPRECATION")
        targetSdk = 34
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
        // Enable core-library desugaring so java.time.Duration#toMillis works
        // on the minSdk 21 floor (otherwise lint flags it as API 26+ only).
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = "11"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        getByName("debug") {
            // JaCoCo needs the debug variant to be coverage-enabled.
            enableUnitTestCoverage = true
        }
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged Android resources / manifest
            // to run on the JVM. Without this, parity tests that need a
            // `Context` fall back to a no-op shim and the cache-dir code
            // path can't be exercised.
            isIncludeAndroidResources = true
            // Without this, android framework stubs (android.util.Log,
            // android.os.*) throw "Method X not mocked" on every call
            // from production code reached by unit tests. See #173.
            // org.json.* gets a real JVM impl via the test dep below;
            // this flag handles every OTHER android-only symbol.
            isReturnDefaultValues = true
            all {
                it.useJUnitPlatform()
                it.testLogging {
                    events("passed", "skipped", "failed")
                }
                // Surface the cross-language fixtures directory so tests
                // can locate packages/test-fixtures-sdk-parity/fixtures/
                // regardless of Gradle's working directory.
                it.systemProperty(
                    "confeature.repo.root",
                    rootProject.projectDir.parentFile.parentFile.absolutePath,
                )
            }
        }
    }
}

dependencies {
    // Required for java.time.* on minSdk < 26 (we target minSdk 21).
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")

    // AndroidX annotations — @Nullable / @NonNull etc.
    implementation("androidx.annotation:annotation:1.8.2")

    // OkHttp 4.x — synchronous HTTP client used by ConfigFetcher.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Kotlin coroutines for the suspend variants.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Test scope: JUnit Jupiter + AssertJ + Robolectric + MockWebServer.
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testImplementation("org.junit.jupiter:junit-jupiter-params:5.10.3")
    testImplementation("org.assertj:assertj-core:3.26.3")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // Spec 069 US3 — the official ConfigCat Android SDK is the conformance
    // reference for ApiSurfaceConformanceTest (reflection over class metadata
    // only — no network, no Android-framework-dependent instantiation).
    // Pinned per research §R2.
    testImplementation("com.configcat:configcat-android-client:10.4.3")
    // Real JVM impl of org.json. Android ships its own org.json at runtime,
    // but the AGP unit-test classpath stubs it — every JSONObject method
    // throws "not mocked" RuntimeException. JsonParser internally uses
    // org.json.* and is exercised by parity / cache-key / fetch tests. See #173.
    testImplementation("org.json:json:20240303")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.3")
}

// JaCoCo report wired against the debug unit-test task; AGP's
// `enableUnitTestCoverage = true` provisions the exec data we read here.
tasks.register<JacocoReport>("jacocoTestReport") {
    dependsOn("testDebugUnitTest")
    reports {
        xml.required.set(true)
        html.required.set(true)
        csv.required.set(false)
    }
    val fileFilter = listOf(
        "**/R.class",
        "**/R$*.class",
        "**/BuildConfig.*",
        "**/Manifest*.*",
        "**/*Test*.*",
    )
    classDirectories.setFrom(
        files(
            fileTree("${layout.buildDirectory.get()}/tmp/kotlin-classes/debug") {
                exclude(fileFilter)
            },
        ),
    )
    sourceDirectories.setFrom(files("src/main/java"))
    executionData.setFrom(
        fileTree(layout.buildDirectory.get()) {
            include("**/*.exec", "**/*.ec")
        },
    )
}

tasks.register<JacocoCoverageVerification>("jacocoTestCoverageVerification") {
    dependsOn("jacocoTestReport")
    violationRules {
        rule {
            limit {
                counter = "LINE"
                minimum = "0.80".toBigDecimal()
            }
        }
    }
    classDirectories.setFrom(
        files(
            fileTree("${layout.buildDirectory.get()}/tmp/kotlin-classes/debug") {
                exclude(
                    "**/R.class",
                    "**/R$*.class",
                    "**/BuildConfig.*",
                    "**/Manifest*.*",
                    "**/*Test*.*",
                )
            },
        ),
    )
    sourceDirectories.setFrom(files("src/main/java"))
    executionData.setFrom(
        fileTree(layout.buildDirectory.get()) {
            include("**/*.exec", "**/*.ec")
        },
    )
}

tasks.named("check") {
    dependsOn("jacocoTestCoverageVerification")
}
