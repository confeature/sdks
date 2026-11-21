// SPDX-License-Identifier: MIT

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository { maven { url = uri("https://maven.confeature.io") } }
            filter { includeGroup("io.confeature") }
        }
        mavenCentral()
        google()
    }
}

rootProject.name = "confeature-openfeature-kotlin"
