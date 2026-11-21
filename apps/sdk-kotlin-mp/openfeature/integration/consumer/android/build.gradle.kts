// SPDX-License-Identifier: MIT

plugins {
    id("com.android.application") version "8.10.1"
    kotlin("android") version "2.2.21"
}

android {
    namespace = "io.confeature.kmp.openfeature.consumer"
    compileSdk = 34
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "io.confeature.kmp.openfeature.consumer"
        minSdk = 21
        targetSdk = 34
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildTypes {
        create("minified") {
            initWith(getByName("release"))
            isMinifyEnabled = true
            matchingFallbacks += "release"
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

kotlin {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    sourceSets["main"].kotlin.srcDir(rootProject.file("src"))
}

dependencies {
    implementation("io.confeature:confeature-openfeature-kotlin:${providers.gradleProperty("releaseVersion").get()}")
}
