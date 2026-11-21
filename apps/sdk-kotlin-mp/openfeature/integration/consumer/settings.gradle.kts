// SPDX-License-Identifier: MIT

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

val releaseRepo = providers.gradleProperty("releaseRepo").orNull
    ?: error("Supply the companion's packed Maven repository with -PreleaseRepo.")

dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository { maven { url = uri(releaseRepo) } }
            filter { includeModuleByRegex("io\\.confeature", "confeature-openfeature-kotlin(?:-.*)?") }
        }
        exclusiveContent {
            forRepository { maven { url = uri("https://maven.confeature.io") } }
            filter { includeModuleByRegex("io\\.confeature", "confeature-kotlin-client(?:-.*)?") }
        }
        mavenCentral()
        google()
    }
}

rootProject.name = "openfeature-kotlin-consumer"
include(providers.gradleProperty("consumerTarget").get())
