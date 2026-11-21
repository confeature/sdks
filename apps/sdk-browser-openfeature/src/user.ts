// SPDX-License-Identifier: MIT

import { User } from "@confeature/sdk-browser-js";
import type { EvaluationContext } from "@openfeature/web-sdk";

type Attribute = User["custom"][string];

/** Convert supported attributes into a fresh SDK user owned by this evaluation. */
export function toUser(context: EvaluationContext): User | undefined {
  let identifier: string | undefined;
  let email: string | undefined;
  let country: string | undefined;
  const custom: User["custom"] = Object.create(null);

  for (const [name, value] of Object.entries(context)) {
    if (name === "targetingKey") {
      if (typeof value === "string") identifier = value;
    } else if (name === User.emailAttribute) {
      if (typeof value === "string") email = value;
    } else if (name === User.countryAttribute) {
      if (typeof value === "string") country = value;
    } else if (name !== User.identifierAttribute) {
      const attr = copyAttribute(value);
      if (attr !== undefined) custom[name] = attr;
    }
  }

  if (
    identifier === undefined &&
    email === undefined &&
    country === undefined &&
    Object.keys(custom).length === 0
  ) {
    return undefined;
  }
  return new User(identifier ?? "", email, country, custom);
}

function copyAttribute(value: EvaluationContext[string]): Attribute | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) {
    const items = [...value];
    if (items.every((item) => typeof item === "string")) return items;
  }
  return undefined;
}
