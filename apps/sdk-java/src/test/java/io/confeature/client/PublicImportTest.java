// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Modifier;
import org.junit.jupiter.api.Test;

/**
 * Reflection-check that the public API surface mirrors ConfigCat's Java SDK naming. Acts as a
 * tripwire: any rename / removal of a public type or method that customers compile against will
 * fail this test before the change escapes review.
 */
final class PublicImportTest {

  @Test
  void publicTypesAreReachable() {
    assertThat(ConfeatureClient.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(User.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(FlagOverrides.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(PollingMode.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(LogLevel.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(Logger.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(ConfigCache.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(Snapshot.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(OverrideBehaviour.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(MapOverrideDataSource.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(OverrideDataSource.class.getPackageName()).isEqualTo("io.confeature.client");
    assertThat(Version.class.getPackageName()).isEqualTo("io.confeature.client");
  }

  @Test
  void publicTypesArePublic() {
    for (Class<?> c :
        new Class<?>[] {
          ConfeatureClient.class,
          User.class,
          FlagOverrides.class,
          PollingMode.class,
          LogLevel.class,
          Logger.class,
          ConfigCache.class,
          Snapshot.class,
          OverrideBehaviour.class,
          MapOverrideDataSource.class,
          OverrideDataSource.class,
          Version.class,
        }) {
      assertThat(Modifier.isPublic(c.getModifiers()))
          .as("%s should be public", c.getName())
          .isTrue();
    }
  }

  @Test
  void confeatureClientHasMandatoryStaticFactories() throws Exception {
    assertThat(ConfeatureClient.class.getMethod("get", String.class)).isNotNull();
    assertThat(ConfeatureClient.class.getMethod("builder", String.class)).isNotNull();
  }

  @Test
  void confeatureClientHasMandatoryInstanceApi() throws Exception {
    assertThat(ConfeatureClient.class.getMethod("getValue", String.class, Object.class, User.class))
        .isNotNull();
    assertThat(ConfeatureClient.class.getMethod("forceRefresh")).isNotNull();
    assertThat(ConfeatureClient.class.getMethod("snapshot")).isNotNull();
    assertThat(ConfeatureClient.class.getMethod("close")).isNotNull();
  }

  @Test
  void pollingModeHasMandatoryFactories() throws Exception {
    assertThat(PollingMode.class.getMethod("autoPoll")).isNotNull();
    assertThat(PollingMode.class.getMethod("lazyLoad")).isNotNull();
    assertThat(PollingMode.class.getMethod("manualPoll")).isNotNull();
  }

  @Test
  void flagOverridesHasLocalOnlyFactory() throws Exception {
    assertThat(FlagOverrides.class.getMethod("localOnly", OverrideDataSource.class)).isNotNull();
  }
}
