// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import java.util.Collections;
import java.util.Map;

/**
 * Targeting-context value object for the upstream conformance corpus (spec 126) whose custom
 * attributes stay TYPED.
 *
 * <p>The public {@code io.confeature.client.User} stringifies custom values (its documented
 * contract: {@code Map<String,String>}); the conversion-driver cases feed numbers / arrays / epochs
 * that MUST reach the comparator layer un-stringified. The evaluator reads attributes through the
 * package-private {@link Evaluator.UserView} duck-type, so this corpus-local stand-in is sufficient
 * and avoids redesigning the public surface. Mirrors the PHP / Ruby {@code CorpusUser} struct and
 * the Python conformance harness {@code User}.
 */
final class CorpusUserView implements Evaluator.UserView {

  private final String identifier;
  private final String email;
  private final String country;
  private final Map<String, Object> custom;

  CorpusUserView(String identifier, String email, String country, Map<String, Object> custom) {
    this.identifier = identifier == null ? "" : identifier;
    this.email = email;
    this.country = country;
    this.custom = custom;
  }

  @Override
  public String identifier() {
    return identifier;
  }

  @Override
  public Object attribute(String name) {
    switch (name) {
      case "Identifier":
        return identifier;
      case "Email":
        return email;
      case "Country":
        return country;
      default:
        return custom == null ? null : custom.get(name);
    }
  }

  @Override
  public Iterable<String> customKeys() {
    return custom == null ? Collections.emptyList() : custom.keySet();
  }

  String customRepr() {
    return String.valueOf(custom);
  }
}
