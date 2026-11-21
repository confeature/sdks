// SPDX-License-Identifier: MIT

plugins {
    id("com.android.application") version "8.7.0"
    kotlin("android") version "2.2.21"
}

android {
    namespace = "io.confeature.kmp.openfeature.consumer"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.confeature.kmp.openfeature.consumer"
        minSdk = 21
        targetSdk = 34
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

kotlin {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    sourceSets["main"].kotlin.srcDir(rootProject.file("src"))
}

dependencies {
    implementation("io.confeature:confeature-openfeature-kotlin:0.1.0")
}
