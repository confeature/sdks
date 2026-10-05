// SPDX-License-Identifier: MIT

/**
 * ESLint config for @confeature/sdk-angular.
 *
 * Layered:
 *  1. `@angular-eslint/recommended` for the Angular-specific rules
 *     (directive selectors, pipe naming, no-host-metadata-property, …).
 *  2. The repo root's TS rules (inherited via `extends: "../../"`).
 *
 * We deliberately do NOT extend `@angular-eslint/template` here —
 * this SDK has no Angular HTML templates (everything is inline TS).
 */

module.exports = {
  root: true,
  parserOptions: {
    project: ["./tsconfig.lib.json", "./tsconfig.spec.json"],
    tsconfigRootDir: __dirname,
  },
  overrides: [
    {
      files: ["*.ts"],
      extends: ["plugin:@angular-eslint/recommended"],
      rules: {
        "@angular-eslint/directive-selector": [
          "error",
          { type: "attribute", prefix: "cf", style: "camelCase" },
        ],
        "@angular-eslint/component-selector": [
          "error",
          { type: "element", prefix: "cf", style: "kebab-case" },
        ],
      },
    },
  ],
};
