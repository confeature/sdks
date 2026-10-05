// SPDX-License-Identifier: MIT

/**
 * Targeting context for a flag evaluation.
 *
 * Signature mirrors `configcat-common`'s `User` class verbatim
 * (identifier required, email/country optional, custom attributes as a
 * record). The v1 evaluator IGNORES the user — segments and targeting
 * rules are not consumed yet. The type is exposed so that customer code
 * that constructs `new User(...)` continues to compile under
 * `@confeature/sdk-node`.
 */
export class User {
  /** Custom attribute keys reserved for the well-known fields. */
  static identifierAttribute = "Identifier";
  static emailAttribute = "Email";
  static countryAttribute = "Country";

  constructor(
    public identifier: string,
    public email?: string,
    public country?: string,
    public custom: Record<string, string | number | boolean | readonly string[] | Date> = {},
  ) {}
}

/**
 * Read a well-known or custom attribute off a {@link User}, mirroring
 * common-js `getUserAttribute`: `Identifier` → `identifier ?? ""`, `Email` →
 * `email`, `Country` → `country`, anything else → `custom[name]`. Returns
 * `undefined`/`""` for an absent attribute (the evaluator treats both as
 * "missing").
 */
export function getUserAttribute(
  user: User,
  name: string,
): string | number | boolean | readonly string[] | Date | undefined {
  switch (name) {
    case User.identifierAttribute:
      return user.identifier ?? "";
    case User.emailAttribute:
      return user.email;
    case User.countryAttribute:
      return user.country;
    default:
      return user.custom?.[name];
  }
}
