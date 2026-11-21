// SPDX-License-Identifier: MIT

rootProject.name = "confeature-openfeature-java"

if (providers.gradleProperty("useLocalConfeatureSdk").orNull == "true") {
    includeBuild("..")
}
