// SPDX-License-Identifier: MIT

// Exercise the real commands and artifact receipt for every split-mirror route.
export const mirrorPublishCases = [
  ["publish-packagist", "git@github.com:confeature/confeature-php-sdk.git", "pack-packagist"],
  ["publish-swiftpm", "git@github.com:confeature/confeature-swift.git", "pack-swiftpm"],
  [
    "publish-swiftpm-openfeature",
    "git@github.com:confeature/confeature-swift-openfeature.git",
    "pack-swiftpm-openfeature",
  ],
];
