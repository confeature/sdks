# SPDX-License-Identifier: MIT
#
# CMake build for the Confeature C++ SDK. Drop-in compatible with the
# upstream `configcat-cpp` library — constitution Principle II
# (NON-NEGOTIABLE). C++17 + libcurl + OpenSSL 3 + nlohmann/json + Catch2.
#
# Targets:
#   confeature        — static + dynamic library (libconfeature.a / .dylib).
#   confeature_tests  — Catch2 v3 test runner (gated by CONFEATURE_ENABLE_TESTS).
#
# nlohmann/json + Catch2 are pulled via FetchContent so a clean clone
# builds without extra system packages (apt-get / brew install are still
# recommended for libcurl + OpenSSL — see README).

cmake_minimum_required(VERSION 3.20)
project(confeature
    VERSION 0.1.0
    DESCRIPTION "Confeature C++ SDK — drop-in compatible with configcat-cpp"
    LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Export compile_commands.json so clang-tidy + clangd resolve include
# paths without a manual database.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(CONFEATURE_ENABLE_TESTS "Build the Catch2 test runner" OFF)
option(CONFEATURE_ENABLE_COVERAGE "Enable --coverage instrumentation (gcov/lcov)" OFF)

# --- Required system dependencies --------------------------------------------
find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)

# --- Vendored header-only deps via FetchContent ------------------------------
include(FetchContent)
set(FETCHCONTENT_QUIET TRUE)

FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
    GIT_SHALLOW TRUE
)

if(CONFEATURE_ENABLE_TESTS)
    FetchContent_Declare(
        Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG v3.5.4
        GIT_SHALLOW TRUE
    )

    # ── Spec 071 US3 — API-surface conformance dependency ─────────────
    #
    # The official ConfigCat C++ SDK (`configcat-cpp` v4.0.5) is pulled
    # as a TEST-SCOPE source dependency to anchor the API-surface
    # conformance test. We only need the public headers under
    # `include/configcat/` — the conformance test references method
    # signatures via `decltype` and SFINAE detectors and never links
    # against the configcat library (which would require vcpkg-managed
    # `unofficial-hash-library` and `semver` deps we don't ship).
    #
    # `SOURCE_SUBDIR include` is the no-op trick: `include/` carries no
    # `CMakeLists.txt`, so `FetchContent_MakeAvailable` resolves the
    # source tree without invoking `add_subdirectory()` — we just get
    # the headers, no configure-time side-effects from configcat-cpp's
    # top-level `CMakeLists.txt`.
    FetchContent_Declare(
        configcat-cpp
        GIT_REPOSITORY https://github.com/configcat/cpp-sdk.git
        GIT_TAG v4.0.5
        GIT_SHALLOW TRUE
        SOURCE_SUBDIR include
    )
endif()

# nlohmann/json is header-only — disable its tests / install / etc.
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install OFF CACHE INTERNAL "")
FetchContent_MakeAvailable(nlohmann_json)
if(CONFEATURE_ENABLE_TESTS)
    FetchContent_MakeAvailable(Catch2)
    FetchContent_MakeAvailable(configcat-cpp)
endif()

# --- Library target ----------------------------------------------------------
set(CONFEATURE_SOURCES
    src/user.cpp
    src/logger.cpp
    src/flag_overrides.cpp
    src/polling_mode.cpp
    src/client.cpp
    src/hooks.cpp
    src/snapshot.cpp
    src/filesystem_cache.cpp
    src/internal/sdk_key.cpp
    src/internal/override_eval.cpp
    src/internal/hashing.cpp
    src/internal/semver.cpp
    src/internal/comparators.cpp
    src/internal/evaluator.cpp
    src/internal/config_fetcher.cpp
)

add_library(confeature ${CONFEATURE_SOURCES})
add_library(confeature::confeature ALIAS confeature)

target_include_directories(confeature
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(confeature
    PUBLIC
        nlohmann_json::nlohmann_json
    PRIVATE
        CURL::libcurl
        OpenSSL::Crypto
        OpenSSL::SSL
)

target_compile_options(confeature PRIVATE
    -Wall -Wextra -Wpedantic -Wno-unused-parameter
)

if(CONFEATURE_ENABLE_COVERAGE)
    target_compile_options(confeature PRIVATE --coverage -O0 -g)
    target_link_options(confeature PRIVATE --coverage)
endif()

# --- Tests -------------------------------------------------------------------
if(CONFEATURE_ENABLE_TESTS)
    enable_testing()

    set(CONFEATURE_TEST_SOURCES
        tests/sdk_key_test.cpp
        tests/override_eval_test.cpp
        tests/evaluator_test.cpp
        tests/hashing_test.cpp
        tests/semver_test.cpp
        tests/evaluator_upstream_corpus_test.cpp
        tests/config_fetcher_test.cpp
        tests/wire_cases_test.cpp
        tests/filesystem_cache_test.cpp
        tests/client_test.cpp
        tests/cache_key_fixtures_test.cpp
        tests/parity_corpus_test.cpp
        tests/parity_rules_test.cpp
        tests/api_surface_conformance_test.cpp
        tests/online_offline_test.cpp
        tests/hooks_test.cpp
    )

    add_executable(confeature_tests ${CONFEATURE_TEST_SOURCES})
    target_link_libraries(confeature_tests
        PRIVATE
            confeature
            Catch2::Catch2WithMain
            CURL::libcurl
            OpenSSL::Crypto
    )
    target_include_directories(confeature_tests PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${CMAKE_CURRENT_SOURCE_DIR}/tests
        # Spec 071 US3 — configcat-cpp public headers for the
        # API-surface conformance test. Header-only consumption (we
        # never link against the configcat library).
        ${configcat-cpp_SOURCE_DIR}/include
    )
    target_compile_options(confeature_tests PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )

    if(CONFEATURE_ENABLE_COVERAGE)
        target_compile_options(confeature_tests PRIVATE --coverage -O0 -g)
        target_link_options(confeature_tests PRIVATE --coverage)
    endif()

    include(CTest)
    include(Catch)
    catch_discover_tests(confeature_tests)
endif()
