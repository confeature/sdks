// SPDX-License-Identifier: MIT

import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.konan.target.HostManager

// Android target is opt-in via -PenableAndroid=true. The plugin block
// evaluates eagerly, so the Android plugin must be applied unconditionally
// when the flag is on; when off we skip the plugin entirely.
val enableAndroidPlugin: Boolean =
    (providers.gradleProperty("enableAndroid").orNull?.toBoolean()) ?: false

plugins {
    kotlin("multiplatform") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("org.jetbrains.kotlinx.kover") version "0.8.3"
    id("io.gitlab.arturbosch.detekt") version "1.23.7"
    // The AGP must be declared in the plugins block. We keep it `apply
    // false` and then conditionally apply below to avoid forcing the
    // Android SDK on developer machines that don't have ANDROID_HOME set.
    id("com.android.library") version "8.7.0" apply false
}

if (enableAndroidPlugin) {
    apply(plugin = "com.android.library")
}

group = "io.confeature"
version = "0.1.0"

// Pinned dependency versions — keep in lockstep with the Java/Android SDKs
// where the matrix overlaps (e.g. coroutines + kotlinx-serialization).
val coroutinesVersion = "1.8.1"
val serializationVersion = "1.7.3"
val ktorVersion = "3.0.0"

// --- Target guards ---
// `androidTarget` requires the Android Gradle Plugin (`com.android.library`)
// which transitively requires the Android SDK to be available. To keep the
// project buildable on developer machines that don't have ANDROID_HOME set,
// the Android target is opt-in via the `enableAndroid` Gradle property:
//
//     ./gradlew -PenableAndroid=true build
//
// The CI matrix (macOS slot used by sdk-android / sdk-swift) MUST pass this
// flag. Default = off, so the project compiles on Linux CI runners.
//
// Similarly, KMP iOS native compilation is only available on macOS hosts —
// the `HostManager.hostIsMac` guard is the canonical KMP idiom (mirrors
// the JetBrains template repos). The macOS CI slot picks them up.
val enableAndroid: Boolean = (project.findProperty("enableAndroid") as String?)?.toBoolean() ?: false

kotlin {
    // Suppress the "expect/actual classes are in Beta" warning — the
    // feature has shipped in Kotlin 2.0+ stable and is the only way to
    // implement multiplatform abstractions like Sha256Provider /
    // FilesystemCache. See KT-61573.
    targets.configureEach {
        compilations.configureEach {
            compileTaskProvider.configure {
                compilerOptions {
                    freeCompilerArgs.add("-Xexpect-actual-classes")
                }
            }
        }
    }

    // --- JVM target ---
    @OptIn(ExperimentalKotlinGradlePluginApi::class)
    jvm {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_11)
        }
        testRuns["test"].executionTask.configure {
            useJUnitPlatform()
            // Surface the cross-language fixtures directory so tests can
            // locate packages/test-fixtures-sdk-parity/fixtures/ even when
            // Gradle's working directory is the project root. Mirrors
            // apps/sdk-java/build.gradle.kts.
            systemProperty(
                "confeature.repo.root",
                rootProject.projectDir.parentFile.parentFile.absolutePath,
            )
        }
    }

    // --- Android target (opt-in) ---
    if (enableAndroidPlugin) {
        @OptIn(ExperimentalKotlinGradlePluginApi::class)
        androidTarget {
            compilerOptions {
                jvmTarget.set(JvmTarget.JVM_11)
            }
        }
    }

    // --- Native iOS targets ---
    if (HostManager.hostIsMac) {
        iosArm64()
        iosX64()
        iosSimulatorArm64()
    }

    // --- JS (IR) target ---
    js(IR) {
        nodejs()
        browser()
        binaries.library()
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
                implementation("io.ktor:ktor-client-core:$ktorVersion")
            }
        }
        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
            }
        }

        val jvmMain by getting {
            dependencies {
                implementation("io.ktor:ktor-client-cio:$ktorVersion")
            }
        }
        val jvmTest by getting {
            dependencies {
                implementation(kotlin("test-junit5"))
                implementation("org.junit.jupiter:junit-jupiter:5.10.3")
                implementation("io.ktor:ktor-client-mock:$ktorVersion")
                runtimeOnly("org.junit.platform:junit-platform-launcher:1.10.3")

                // Spec 069 US3 — the official ConfigCat Kotlin SDK is the
                // conformance reference for ApiSurfaceConformanceTest
                // (reflection only, no network). Pinned per research §R2.
                implementation("com.configcat:configcat-kotlin-client:5.1.0")
            }
        }

        val jsMain by getting {
            dependencies {
                implementation("io.ktor:ktor-client-js:$ktorVersion")
            }
        }

        if (enableAndroidPlugin) {
            val androidMain by getting {
                dependencies {
                    implementation("io.ktor:ktor-client-okhttp:$ktorVersion")
                }
            }
        }

        if (HostManager.hostIsMac) {
            val iosArm64Main by getting
            val iosX64Main by getting
            val iosSimulatorArm64Main by getting
            val iosMain by creating {
                dependsOn(commonMain)
                dependencies {
                    implementation("io.ktor:ktor-client-darwin:$ktorVersion")
                }
            }
            iosArm64Main.dependsOn(iosMain)
            iosX64Main.dependsOn(iosMain)
            iosSimulatorArm64Main.dependsOn(iosMain)
        }
    }
}

// --- Android library config (only when the AGP is applied) ---
if (enableAndroidPlugin) {
    extensions.configure<com.android.build.gradle.LibraryExtension>("android") {
        namespace = "io.confeature.kmp"
        compileSdk = 34
        defaultConfig {
            minSdk = 21
        }
        compileOptions {
            sourceCompatibility = JavaVersion.VERSION_11
            targetCompatibility = JavaVersion.VERSION_11
        }
    }
}

// --- Detekt (KMP-compatible lint) ---
detekt {
    buildUponDefaultConfig = true
    allRules = false
    config.setFrom(files("$projectDir/detekt.yml"))
    source.setFrom(
        files(
            "src/commonMain/kotlin",
            "src/jvmMain/kotlin",
            "src/jsMain/kotlin",
            "src/iosMain/kotlin",
            "src/commonTest/kotlin",
            "src/jvmTest/kotlin",
        ),
    )
}

tasks.withType<io.gitlab.arturbosch.detekt.Detekt>().configureEach {
    reports {
        html.required.set(true)
        xml.required.set(false)
        txt.required.set(false)
        sarif.required.set(false)
        md.required.set(false)
    }
    jvmTarget = "11"
}

// --- Kover (coverage for JVM target — authoritative per spec FR-018) ---
kover {
    reports {
        // Exclude pure data holders + Kotlin-synthesised boilerplate
        // (data-class component*/copy/hashCode/equals, enum scaffolding,
        // version singletons, default-logger printlns). Hand-written logic
        // stays in scope. Mirrors the JaCoCo / dotnet exclusion lists.
        filters {
            excludes {
                classes(
                    "io.confeature.kmp.User",
                    "io.confeature.kmp.User\$*",
                    "io.confeature.kmp.LogLevel",
                    "io.confeature.kmp.OverrideBehaviour",
                    "io.confeature.kmp.Version",
                    "io.confeature.kmp.PrintlnLogger",
                )
            }
        }
        verify {
            rule {
                bound {
                    minValue = 80
                }
            }
        }
    }
}

// `check` should run jvmTest, detekt, and kover verification.
tasks.named("check") {
    dependsOn("jvmTest")
    dependsOn("detekt")
    dependsOn("koverVerify")
}
