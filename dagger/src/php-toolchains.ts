// SPDX-License-Identifier: MIT

import { dag, type Container, type Directory } from "@dagger.io/dagger";

function phpWithComposer(image: string): Container {
  const composer = dag.container().from("composer:2.9.8").file("/usr/bin/composer");
  return dag
    .container()
    .from(image)
    .withEnvVariable("CI", "true")
    .withEnvVariable("COMPOSER_CACHE_DIR", "/cache/composer")
    .withMountedCache("/cache/composer", dag.cacheVolume("composer-cache"))
    .withFile("/usr/local/bin/composer", composer);
}

export function phpToolchain(source: Directory): Container {
  return (
    phpWithComposer("php:8.3.35-cli-bookworm")
      // PHPUnit needs mbstring, dom, xml, zip and the pcov coverage driver.
      .withExec([
        "bash",
        "-eu",
        "-c",
        'apt-get update >/dev/null && apt-get install -y --no-install-recommends git unzip libonig-dev libxml2-dev libzip-dev $PHPIZE_DEPS >/dev/null && docker-php-ext-install -j"$(nproc)" mbstring dom xml zip >/dev/null && pecl install pcov >/dev/null && docker-php-ext-enable pcov && rm -rf /var/lib/apt/lists/*',
      ])
      .withMountedDirectory("/work", source)
      .withWorkdir("/work/apps/sdk-php")
  );
}

export function phpConsumerToolchain(source: Directory, image: string): Container {
  return phpWithComposer(image)
    .withExec([
      "sh",
      "-ec",
      "apt-get update -qq && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/*",
    ])
    .withMountedDirectory("/work", source)
    .withWorkdir("/work");
}
