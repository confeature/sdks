// SPDX-License-Identifier: MIT

/**
 * Key-safe records for user-controlled keys (#826).
 *
 * A setting key, an override key and a user attribute name are all free text:
 * ConfigCat reserves no names, so `__proto__`, `constructor` and `toString` are
 * valid keys. A plain `{}` gets both directions wrong for them — assigning
 * `obj["__proto__"] = x` replaces the object's prototype instead of creating
 * the key (the flag is dropped), and reading `obj["toString"]` from a map that
 * lacks the key finds `Object.prototype.toString` (a phantom setting). This
 * module is the single home of the rule: build such records with
 * {@link keyedRecord}, read them with {@link ownValue}. Neither rejects or
 * renames a key.
 */

/** A record with no prototype, so every key, `__proto__` included, is an ordinary own property. */
export function keyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Read `key` only when it is an OWN property of `map`, so a record built by a
 * caller as a plain `{}` (or parsed by `JSON.parse`) never yields an inherited
 * `Object.prototype` member as if it were a configured value.
 */
export function ownValue<T>(
  map: Readonly<Record<string, T>> | null | undefined,
  key: string,
): T | undefined {
  return map != null && Object.hasOwn(map, key) ? map[key] : undefined;
}
