// SPDX-License-Identifier: MIT

plugins {
    `java-library`
    jacoco
    id("com.diffplug.spotless") version "6.25.0"
}

group = "io.confeature"
version = "0.1.0"

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
    withJavadocJar()
    withSourcesJar()
}

repositories {
    mavenCentral()
}

dependencies {
    // SLF4J is the logging facade. Customers wire their own backend.
    api("org.slf4j:slf4j-api:2.0.13")

    // OkHttp 4.x — synchronous HTTP client used by ConfigFetcher.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Jackson Databind for parsing config_v6.json bodies.
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.2")

    // Test scope: JUnit Jupiter + AssertJ + MockWebServer.
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testImplementation("org.junit.jupiter:junit-jupiter-params:5.10.3")
    testImplementation("org.assertj:assertj-core:3.26.3")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    // Spec 069 US3 — the official ConfigCat Java SDK is the conformance reference
    // for ApiSurfaceConformanceTest (reflection only, no network). Pinned per
    // research §R2; bumping the version is a separate change.
    testImplementation("com.configcat:configcat-java-client:10.0.0")
    testRuntimeOnly("org.slf4j:slf4j-simple:2.0.13")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.3")
}

tasks.named<Test>("test") {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
    // Surface the cross-language fixtures directory so tests can locate
    // packages/test-fixtures-sdk-parity/fixtures/ even when Gradle's
    // working directory is the project root.
    systemProperty("confeature.repo.root", rootProject.projectDir.parentFile.parentFile.absolutePath)
    finalizedBy(tasks.named("jacocoTestReport"))
}

tasks.named<JacocoReport>("jacocoTestReport") {
    dependsOn(tasks.named("test"))
    reports {
        xml.required.set(true)
        html.required.set(true)
        csv.required.set(false)
    }
}

tasks.named<JacocoCoverageVerification>("jacocoTestCoverageVerification") {
    dependsOn(tasks.named("jacocoTestReport"))
    violationRules {
        rule {
            limit {
                counter = "LINE"
                minimum = "0.80".toBigDecimal()
            }
        }
    }
}

spotless {
    java {
        target("src/**/*.java")
        // google-java-format 1.23+ ships with the JDK 21+ internal
        // javac module-open args the formatter needs to introspect
        // the AST on modern JDKs (OpenJDK 25 locally, Temurin 21 on CI).
        googleJavaFormat("1.27.0")
        // The SPDX header is enforced as the first comment of every
        // .java file. Spotless will fail the build (clean check) if a
        // file under src/ is missing the header.
        licenseHeader("// SPDX-License-Identifier: MIT")
        endWithNewline()
    }
    kotlinGradle {
        target("*.gradle.kts")
        ktlint("1.3.1")
    }
}

tasks.named("check") {
    dependsOn(tasks.named("jacocoTestCoverageVerification"))
}

tasks.named<Jar>("jar") {
    archiveBaseName.set("confeature")
    manifest {
        attributes(
            "Implementation-Title" to "confeature-java-sdk",
            "Implementation-Version" to project.version,
        )
    }
}
