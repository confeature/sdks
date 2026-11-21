// SPDX-License-Identifier: MIT

plugins {
    `java-library`
    `maven-publish`
}

group = "io.confeature"
version = "0.1.0"

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
    withJavadocJar()
    withSourcesJar()
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(11)
}

repositories {
    exclusiveContent {
        forRepository {
            maven {
                name = "confeature"
                url = uri("https://maven.confeature.io")
            }
        }
        filter {
            includeGroup("io.confeature")
        }
    }
    mavenCentral()
}

dependencies {
    api("io.confeature:confeature-java-client:0.2.0")
    api("dev.openfeature:sdk:1.23.0")
    testImplementation("com.fasterxml.jackson.core:jackson-databind:2.17.2")
}

tasks.register<JavaExec>("openFeatureSmoke") {
    classpath = sourceSets["test"].runtimeClasspath
    mainClass.set("io.confeature.openfeature.OpenFeatureSmoke")
}

tasks.named<Jar>("jar") {
    from("../LICENSE") {
        into("META-INF")
    }
}

publishing {
    publications {
        create<MavenPublication>("release") {
            from(components["java"])
            pom {
                name.set("Confeature OpenFeature provider for Java")
                description.set("Evaluate OpenFeature flags with the Confeature Java SDK.")
                url.set("https://github.com/confeature/sdks/tree/main/apps/sdk-java/openfeature")
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
                    url.set("https://github.com/confeature/sdks")
                }
            }
        }
    }
    repositories {
        maven {
            name = "release"
            url = uri(layout.buildDirectory.dir("release-repo"))
        }
    }
}
