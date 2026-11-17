<!-- SPDX-License-Identifier: MIT -->

# Changelog

## 0.1.1

- Fix: the default base URL is `https://cdn.confeature.io`. 0.1.0's default
  named a host that does not resolve, so a client that set no base URL served
  every flag's default value.

## 0.1.0

- First release of the Confeature Dart / Flutter SDK, drop-in compatible with
  ConfigCat's `configcat_client`. Published from
  [confeature/sdks](https://github.com/confeature/sdks).
