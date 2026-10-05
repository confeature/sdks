# confeature (C++)

<!-- SPDX-License-Identifier: MIT -->

Confeature C++ SDK (C++17). Drop-in compatible with `configcat-cpp`. CMake-based, depends on libcurl, OpenSSL, and nlohmann/json (header-only).

> **License**: MIT.

## Install

### CMake FetchContent

```cmake
include(FetchContent)
FetchContent_Declare(
    confeature
    GIT_REPOSITORY https://github.com/confeature/sdks.git
    GIT_TAG v0.1.0
    SOURCE_SUBDIR apps/sdk-cpp
)
FetchContent_MakeAvailable(confeature)

target_link_libraries(my_app PRIVATE confeature::confeature)
```

### System install

```bash
cd apps/sdk-cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
sudo cmake --install build
```

## Quickstart

```cpp
#include <confeature/confeature.h>

int main() {
    auto client = confeature::ConfeatureClient::create(
        "configcat-sdk-1/XXXXXXXXXXXXXXXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXX");
    confeature::User user{.identifier = "alice@example.com"};
    bool enabled = client->getValue("new-checkout-flow", false, &user);
    client->close();
    return enabled ? 0 : 1;
}
```

## SDK keys

Confeature mints SDK keys in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>` (alphabet `A-Z a-z 0-9 _ -`), so the
same key also works in a stock ConfigCat SDK. Keys minted earlier, in the
`confeature-sdk-1-<32 chars>-<32 chars>` shape, stay valid until you rotate
them. A key in neither shape logs a redacted `INVALID_SDK_KEY` warning; the
client still starts.

## Migrating from `configcat-cpp`

```diff
- #include <configcat/configcatclient.h>
- auto client = configcat::ConfigCatClient::create("configcat-sdk-1/XXXXXXXXXXXXXXXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXX");
+ #include <confeature/confeature.h>
+ auto client = confeature::ConfeatureClient::create("configcat-sdk-1/XXXXXXXXXXXXXXXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXX");
```

## Architecture

- HTTP: libcurl 7.x.
- JSON: nlohmann/json (header-only).
- Crypto: OpenSSL 3.x (`EVP_sha256`).
- Cache: filesystem at `$HOME/.cache/confeature/` (atomic write).
- Polling: `std::thread` + `std::condition_variable`; idempotent `close()`.

## License

[MIT](./LICENSE).
