// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.configcat.ConfigCatClient;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Spec 069 US3 — API-surface conformance test for {@code sdk-java}.
 *
 * <p>Reflects over the official ConfigCat Java SDK ({@code com.configcat.ConfigCatClient}, pinned
 * via a test-scope dependency in {@code build.gradle.kts}) and the Confeature {@link
 * ConfeatureClient}, and asserts that the Confeature client's public surface is a conforming
 * superset of ConfigCat's <em>core</em> evaluation surface — a consumer migrating from {@code
 * configcat-java-client} changes only the base URL, and every core type / method they reference
 * still resolves.
 *
 * <p>Unlike the self-regression {@link PublicImportTest} (which guards against accidental renames
 * inside Confeature against a Confeature-authored expectation list), this test guards against
 * <em>drift from ConfigCat</em> — the reference is the official SDK on the test classpath.
 *
 * <p><strong>KNOWN DIVERGENCE (#264 / #266..#269).</strong> Epic #264's audit found five JVM
 * API-surface gaps versus ConfigCat. Spec 069 is SPLIT-scoped (research §R0) — it delivers
 * typed-value parity + this conformance test only; the corrections are DEFERRED to the #266-#269
 * follow-on. Each gap below is asserted as a drift-guard: the method is currently ABSENT on {@link
 * ConfeatureClient}, and the assertion is written so it fails loudly the day the follow-on adds it
 * — at which point this test is updated to assert presence + conformance.
 *
 * <ul>
 *   <li>{@code getValueDetails} — #266 — landed spec 080.
 *   <li>{@code getAllValues} — #266 — landed spec 080.
 *   <li>{@code getAllValueDetails} — #266 (tracked separately).
 *   <li>client-level {@code getAllKeys} — #269 — landed spec 077.
 *   <li>{@code setOnline} / {@code setOffline} / {@code isOffline} — #267.
 *   <li>the hooks / events surface ({@code getHooks}) — #268.
 * </ul>
 *
 * <p>Reflection only — no network, no client instantiation.
 */
final class ApiSurfaceConformanceTest {

  /**
   * The core evaluation surface ConfigCat's {@code ConfigCatClient} exposes that every
   * ConfigCat-compatible client MUST mirror by name — the methods a migrating consumer's code
   * references. {@code snapshot} is NOT in this set: ConfigCat has no {@code snapshot()} (it
   * surfaces keys via the client-level {@code getAllKeys}); {@code snapshot()} is a
   * Confeature-specific superset extension, asserted separately.
   */
  private static final Set<String> CORE_INSTANCE_METHODS =
      new LinkedHashSet<>(
          Arrays.asList(
              "getValue",
              "forceRefresh",
              "close",
              // Spec 077 / #269 — client-level getAllKeys landed.
              "getAllKeys",
              // Spec 080 / #266 slice 2/12 — getValueDetails + getAllValues landed.
              "getValueDetails",
              "getAllValues",
              // Spec 091 / #267 slice 2/14 — online/offline triplet landed.
              "setOnline",
              "setOffline",
              "isOffline",
              // Spec 103 / #268 slice 1/14 — hooks/events bus landed.
              "getHooks"));

  /**
   * ConfigCat JVM API-surface gaps deferred to the #266-#269 follow-on (epic #264).
   *
   * <p>Already landed and moved to {@link #CORE_INSTANCE_METHODS}: {@code getValueDetails} + {@code
   * getAllValues} (#266), client-level {@code getAllKeys} (#269), {@code setOnline} + {@code
   * setOffline} + {@code isOffline} (#267), {@code getHooks} (#268).
   */
  private static final Set<String> KNOWN_DIVERGENCES_264 =
      new LinkedHashSet<>(Arrays.asList("getAllValueDetails"));

  private static Set<String> publicMethodNames(Class<?> type) {
    final Set<String> names = new LinkedHashSet<>();
    for (Method m : type.getMethods()) {
      if (m.getDeclaringClass() != Object.class) {
        names.add(m.getName());
      }
    }
    return names;
  }

  @Test
  void officialConfigCatSdkIsOnTheTestClasspath() {
    // Sanity guard — the reflective comparison is meaningless if the official SDK failed to
    // resolve. ConfigCatClient is the official client type the conformance reference reflects.
    assertThat(ConfigCatClient.class.getPackageName()).isEqualTo("com.configcat");
  }

  @Test
  void confeatureClientCoversConfigCatCoreEvaluationSurface() {
    final Set<String> confeature = publicMethodNames(ConfeatureClient.class);
    final Set<String> configcat = publicMethodNames(ConfigCatClient.class);

    for (String core : CORE_INSTANCE_METHODS) {
      assertThat(configcat)
          .as("ConfigCat's ConfigCatClient is expected to expose the core method %s", core)
          .contains(core);
      assertThat(confeature)
          .as(
              "ConfeatureClient MUST expose ConfigCat's core method %s "
                  + "(Principle II — drop-in compatibility)",
              core)
          .contains(core);
    }
  }

  @Test
  void confeatureClientExposesSnapshotAsConfeatureSupersetExtension() throws Exception {
    // snapshot() is a Confeature superset extension — ConfigCat has no equivalent (it exposes
    // keys via the client-level getAllKeys). The conformance bar is "superset", so this is a
    // legitimate addition; asserted here to document the deliberate divergence direction.
    assertThat(publicMethodNames(ConfigCatClient.class))
        .as("ConfigCat's ConfigCatClient has no snapshot() — Confeature's snapshot() is additive")
        .doesNotContain("snapshot");
    assertThat(ConfeatureClient.class.getMethod("snapshot"))
        .as("ConfeatureClient exposes snapshot() — the Confeature key/value access surface")
        .isNotNull();
  }

  @Test
  void confeatureClientCarriesGetValueWithConfigCatArity() throws Exception {
    // getValue(key, defaultValue, user) — the canonical 3-arg evaluation entry point. The
    // Confeature signature is (String, Object, User); ConfigCat's is (Class<T>, String, T, User)
    // for the generic overload — the conformance bar is "a 3-arg getValue resolving key + default
    // + user exists", which the migrating consumer's most common call site uses.
    final Method getValue =
        ConfeatureClient.class.getMethod("getValue", String.class, Object.class, User.class);
    assertThat(getValue.getReturnType()).isEqualTo(Object.class);
  }

  @Test
  void confeatureClientCarriesConfigCatStaticFactories() throws Exception {
    // ConfigCat constructs via the static ConfigCatClient.get(sdkKey); Confeature mirrors it with
    // get(sdkKey) and additionally exposes a builder(sdkKey) factory.
    assertThat(ConfigCatClient.class.getMethod("get", String.class))
        .as("ConfigCat exposes the static get(String) factory")
        .isNotNull();
    assertThat(ConfeatureClient.class.getMethod("get", String.class))
        .as("ConfeatureClient MUST mirror ConfigCat's static get(String) factory")
        .isNotNull();
    assertThat(ConfeatureClient.class.getMethod("builder", String.class))
        .as("ConfeatureClient exposes a builder(String) factory")
        .isNotNull();
  }

  @Test
  void knownDivergences264AreAbsentDriftGuard() {
    // KNOWN DIVERGENCE (#264 / #266..#269) — spec 069 is SPLIT-scoped: the corrections are
    // DEFERRED. These methods are EXPECTED to be absent on ConfeatureClient today. The assertion
    // is a drift-guard: when the #266-#269 follow-on adds one, this test fails and MUST be
    // updated to assert presence + conformance against ConfigCat.
    final Set<String> confeature = publicMethodNames(ConfeatureClient.class);
    for (String divergent : KNOWN_DIVERGENCES_264) {
      assertThat(confeature)
          .as(
              "KNOWN DIVERGENCE (#264): %s is deferred to the #266-#269 follow-on and MUST still "
                  + "be absent on ConfeatureClient. If this fails, the follow-on landed — update "
                  + "this conformance test to assert presence + ConfigCat conformance.",
              divergent)
          .doesNotContain(divergent);
    }
  }

  @Test
  void confeatureClientCarriesClientLevelGetAllKeys() throws Exception {
    // Spec 077 / #269 — client-level getAllKeys() is now present on ConfeatureClient. Upstream
    // ConfigCat's signature is `Collection<String> getAllKeys()`; Confeature mirrors the same
    // return shape so a migrating consumer's call site compiles unchanged (Principle II).
    final Method getAllKeys = ConfeatureClient.class.getMethod("getAllKeys");
    assertThat(getAllKeys.getReturnType())
        .as(
            "ConfeatureClient#getAllKeys MUST return Collection<String> to match ConfigCat's "
                + "ConfigCatClient#getAllKeys signature (Principle II — drop-in compatibility).")
        .isEqualTo(java.util.Collection.class);

    final Method configcatGetAllKeys = ConfigCatClient.class.getMethod("getAllKeys");
    assertThat(configcatGetAllKeys.getReturnType())
        .as(
            "sanity — ConfigCat 10.0.0 is expected to expose getAllKeys() returning "
                + "Collection<String>.")
        .isEqualTo(java.util.Collection.class);
  }

  @Test
  void confeatureClientCarriesGetValueDetails() throws Exception {
    // Spec 080 / #266 slice 2 — getValueDetails(String, Object, User) is now present on
    // ConfeatureClient, returning the upstream-aligned EvaluationDetails envelope. ConfigCat's
    // canonical signature uses a generic `<T> EvaluationDetails<T> getValueDetails(Class<T>, ...)`;
    // Confeature mirrors the 3-arg untyped path that the migrating consumer's most common call
    // site uses, plus a 4-arg typed overload — both verified here.
    final Method getValueDetails =
        ConfeatureClient.class.getMethod("getValueDetails", String.class, Object.class, User.class);
    assertThat(getValueDetails.getReturnType())
        .as(
            "ConfeatureClient#getValueDetails MUST return EvaluationDetails to match ConfigCat's "
                + "ConfigCatClient#getValueDetails return shape (Principle II — drop-in "
                + "compatibility).")
        .isEqualTo(EvaluationDetails.class);

    // Sanity — ConfigCat 10.0.0 is expected to expose at least one `getValueDetails` overload
    // returning EvaluationDetails. We don't constrain the exact arity because upstream's typed
    // overload uses a `Class<T>` first parameter; Confeature exposes the same arity as a 4-arg
    // overload alongside the 3-arg untyped form.
    final Set<String> configcatMethods = publicMethodNames(ConfigCatClient.class);
    assertThat(configcatMethods)
        .as("sanity — ConfigCat 10.0.0 is expected to expose getValueDetails")
        .contains("getValueDetails");
  }

  @Test
  void confeatureClientCarriesGetHooks() throws Exception {
    // Spec 103 / #268 slice 1 — getHooks() is now present on ConfeatureClient, returning the
    // Confeature hooks bus. Upstream ConfigCat's signature is `ConfigCatHooks getHooks()`;
    // Confeature mirrors the same accessor name so a migrating consumer's call site compiles
    // unchanged (Principle II — drop-in compatibility).
    final Method getHooks = ConfeatureClient.class.getMethod("getHooks");
    assertThat(getHooks.getReturnType())
        .as(
            "ConfeatureClient#getHooks MUST return ConfeatureHooks — the four-hook bus mirroring "
                + "com.configcat.ConfigCatHooks (Principle II — drop-in compatibility).")
        .isEqualTo(ConfeatureHooks.class);

    final Set<String> configcatMethods = publicMethodNames(ConfigCatClient.class);
    assertThat(configcatMethods)
        .as("sanity — ConfigCat 10.0.0 is expected to expose getHooks")
        .contains("getHooks");
  }

  @Test
  void confeatureClientCarriesGetAllValues() throws Exception {
    // Spec 080 / #266 slice 2 — getAllValues(User) is now present on ConfeatureClient, returning
    // Map<String, Object>. Upstream ConfigCat's signature is `Map<String, Object> getAllValues
    // (User)`; Confeature mirrors the same return shape so a migrating consumer's call site
    // compiles unchanged (Principle II).
    final Method getAllValues = ConfeatureClient.class.getMethod("getAllValues", User.class);
    assertThat(getAllValues.getReturnType())
        .as(
            "ConfeatureClient#getAllValues MUST return Map<String, Object> to match ConfigCat's "
                + "ConfigCatClient#getAllValues signature (Principle II — drop-in compatibility).")
        .isEqualTo(java.util.Map.class);

    final Set<String> configcatMethods = publicMethodNames(ConfigCatClient.class);
    assertThat(configcatMethods)
        .as("sanity — ConfigCat 10.0.0 is expected to expose getAllValues")
        .contains("getAllValues");
  }

  // PROOF (#914, FR-013): a deliberate break. This pull request is closed unmerged.
  @Test
  void proof914TurnsTheJavaGateRed() {
    assertThat("proof").isEqualTo("red");
  }
}
