// SPDX-License-Identifier: MIT

import java.io.File

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

val releaseRepo = providers.gradleProperty("releaseRepo").map { File(it) }.orNull
    ?: error("Supply the companion's packed Maven repository with -PreleaseRepo.")
require(releaseRepo.isAbsolute && releaseRepo.isDirectory) {
    "The fixture consumer needs a local, absolute Maven directory."
}
val releaseVersion = providers.gradleProperty("releaseVersion").get()
val companion = "confeature-openfeature-kotlin"
require(
    Regex("""[0-9]+\.[0-9]+\.[0-9]+""").matches(releaseVersion) &&
        File(releaseRepo, "io/confeature/$companion/$releaseVersion").isDirectory
) {
    "The fixture Maven directory must contain the selected companion version."
}

dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository { maven { url = uri(releaseRepo) } }
            // These are the only modules trusted from the freshly packed fixture repository.
            filter {
                includeModule("io.confeature", companion)
                includeModule("io.confeature", "$companion-android")
                includeModule("io.confeature", "$companion-iosarm64")
            }
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
