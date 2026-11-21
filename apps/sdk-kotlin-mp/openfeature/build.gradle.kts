// SPDX-License-Identifier: MIT

import org.gradle.api.publish.maven.tasks.PublishToMavenRepository
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.targets.js.nodejs.NodeJsEnvSpec
import org.jetbrains.kotlin.gradle.targets.js.nodejs.NodeJsPlugin
import org.jetbrains.kotlin.konan.target.HostManager

val enableAndroid = providers.gradleProperty("enableAndroid").map(String::toBoolean).getOrElse(false)
val fixtureSources = providers.gradleProperty("fixtureSources").orNull
val fixtureReleaseDirectory = providers.gradleProperty("fixtureReleaseDirectory").orNull?.let { path ->
    java.io.File(path).also {
        require(it.isAbsolute && it.isDirectory) { "The fixture release directory must be a local absolute directory." }
    }
}

plugins {
    kotlin("multiplatform") version "2.2.21"
    id("com.android.library") version "8.7.0" apply false
    `maven-publish`
}

if (enableAndroid) apply(plugin = "com.android.library")

group = "io.confeature"
version = "0.1.0"

plugins.withType<NodeJsPlugin> {
    the<NodeJsEnvSpec>().version.set("22.23.3")
}

kotlin {
    jvm {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
        testRuns["test"].executionTask.configure { useJUnitPlatform() }
    }
    js(IR) {
        nodejs {
            // Let the fixture's 15-second bound identify a stalled transport.
            testTask { useMocha { timeout = "20s" } }
        }
        browser {
            testTask {
                useKarma {
                    if (System.getProperty("user.name") == "root") {
                        useChromeHeadlessNoSandbox()
                    } else {
                        useChromeHeadless()
                    }
                }
            }
        }
    }
    if (enableAndroid) {
        androidTarget {
            compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
            publishLibraryVariants("release")
        }
    }
    if (HostManager.hostIsMac) {
        iosArm64()
        iosSimulatorArm64 {
            providers.gradleProperty("fixtureSimulator").orNull?.let { id ->
                testRuns["test"].deviceId = id
            }
        }
    }

    sourceSets {
        commonMain.dependencies {
            api("io.confeature:confeature-kotlin-client:0.2.0")
            api("dev.openfeature:kotlin-sdk:0.9.0")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
        }
        if (fixtureSources != null) {
            commonTest {
                kotlin.srcDir("integration/kotlin")
                kotlin.srcDir(fixtureSources)
            }
        }
        jvmTest.dependencies {
            implementation(kotlin("test-junit5"))
            runtimeOnly("org.junit.platform:junit-platform-launcher:1.10.3")
        }
        if (enableAndroid) {
            getByName("androidUnitTest").dependencies { implementation(kotlin("test-junit")) }
        }
    }
}

if (enableAndroid) {
    extensions.configure<com.android.build.gradle.LibraryExtension>("android") {
        namespace = "io.confeature.kmp.openfeature"
        compileSdk = 34
        defaultConfig { minSdk = 21 }
        compileOptions {
            sourceCompatibility = JavaVersion.VERSION_11
            targetCompatibility = JavaVersion.VERSION_11
        }
    }
}

val javadocJar by tasks.registering(Jar::class) {
    archiveClassifier.set("javadoc")
    from("README.md")
}

publishing {
    publications.withType<MavenPublication>().configureEach {
        artifact(javadocJar)
        pom {
            name.set("Confeature OpenFeature provider for Kotlin Multiplatform")
            description.set("OpenFeature provider backed by the Confeature Kotlin Multiplatform SDK.")
            url.set("https://github.com/confeature/sdks/tree/main/apps/sdk-kotlin-mp/openfeature")
            licenses {
                license {
                    name.set("MIT")
                    url.set("https://opensource.org/licenses/MIT")
                }
            }
            developers {
                developer {
                    id.set("makerlabs")
                    name.set("MakerLabs")
                    organization.set("MakerLabs")
                    organizationUrl.set("https://confeature.io")
                }
            }
            scm {
                connection.set("scm:git:https://github.com/confeature/sdks.git")
                url.set("https://github.com/confeature/sdks/tree/main/apps/sdk-kotlin-mp/openfeature")
            }
        }
    }
    repositories {
        maven {
            name = "release"
            url = uri(fixtureReleaseDirectory ?: layout.buildDirectory.dir("release-repo").get().asFile)
        }
    }
}

tasks.withType<PublishToMavenRepository>().configureEach {
    doFirst {
        check(gradle.includedBuilds.isEmpty() && fixtureSources == null) {
            "Publish using the released Maven dependencies with fixture sources disabled."
        }
    }
}
