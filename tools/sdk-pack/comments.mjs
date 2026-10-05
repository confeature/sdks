// SPDX-License-Identifier: MIT

/**
 * Which comments ship in a published SDK's JavaScript (#800) — the one home of
 * that decision, imported by every SDK built with `vp pack`.
 *
 * JSDoc stays in the `.d.mts`, where editors and TypeScript read it; in the
 * JS it was half of every gzipped bundle. Legal comments (`@license`, `/*!`,
 * `@preserve`) and pure annotations (`@__PURE__`, `@__NO_SIDE_EFFECTS__`) stay
 * in the JS: the first are notices, the second let a consumer's bundler drop
 * what it does not use. rolldown's `outputOptions.comments`.
 */
export const PUBLISHED_COMMENTS = { legal: true, annotation: true, jsdoc: false };
