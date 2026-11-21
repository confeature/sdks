// SPDX-License-Identifier: MIT

plugins {
    kotlin("multiplatform") version "2.2.21"
}

kotlin {
    iosArm64 {
        binaries.executable {
            entryPoint = "io.confeature.kmp.openfeature.consumer.launch"
        }
    }
    sourceSets.commonMain {
        kotlin.srcDir(rootProject.file("src"))
        dependencies {
            implementation("io.confeature:confeature-openfeature-kotlin:0.1.0")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
        }
    }
}
