// SPDX-License-Identifier: MIT
package io.confeature.openfeature;

import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.Value;
import io.confeature.client.User;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class OpenFeatureUser {
  private OpenFeatureUser() {}

  static User from(EvaluationContext context) {
    if (context == null) {
      return null;
    }
    final String key = context.getTargetingKey();
    final Map<String, Value> attributes = context.asUnmodifiableMap();
    final String email = string(attributes.get("Email"));
    final String country = string(attributes.get("Country"));
    final Map<String, Object> custom = new LinkedHashMap<>();
    for (Map.Entry<String, Value> attribute : attributes.entrySet()) {
      if (isReserved(attribute.getKey())) {
        continue;
      }
      final Object value = nativeValue(attribute.getValue());
      if (value != null) {
        custom.put(attribute.getKey(), value);
      }
    }
    if ((key == null || key.isEmpty()) && email == null && country == null && custom.isEmpty()) {
      return null;
    }
    return User.builder(key == null ? "" : key)
        .email(email)
        .country(country)
        .custom(custom)
        .build();
  }

  private static boolean isReserved(String name) {
    return name == null
        || "Identifier".equals(name)
        || "Email".equals(name)
        || "Country".equals(name)
        || EvaluationContext.TARGETING_KEY.equals(name);
  }

  private static String string(Value value) {
    return value != null && value.isString() ? value.asString() : null;
  }

  private static Object nativeValue(Value value) {
    if (value == null) {
      return null;
    }
    final Object raw = value.asObject();
    if (raw instanceof String
        || raw instanceof Boolean
        || raw instanceof Instant
        || raw instanceof Integer
        || raw instanceof Long
        || raw instanceof Double && Double.isFinite((Double) raw)) {
      return raw;
    }
    return value.isList() ? strings(value.asList()) : null;
  }

  private static List<String> strings(List<Value> entries) {
    final List<String> result = new ArrayList<>(entries.size());
    for (Value entry : entries) {
      final String value = string(entry);
      if (value == null) {
        return null;
      }
      result.add(value);
    }
    return List.copyOf(result);
  }
}
