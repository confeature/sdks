# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  module Internal
    # ConfigCat-semantics semver parse + compare. Ported field-for-field from
    # the spec-117 TS reference (`packages/sdk-shared/src/semver.ts`) and the
    # spec-118 Python port (`apps/sdk-python/.../semver.py`), which themselves
    # vendor ConfigCat `common-js` `Semver.ts`. A Ruby semver gem is NOT used —
    # ConfigCat's strict-parse + precedence edge cases diverge from those gems
    # and would fail the vendored `testmatrix_semantic*` precedence rows.
    #
    # Key behaviours:
    #   - **Strict (non-loose) parse** of the FULL grammar
    #     `v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?`, each core component a
    #     `0|[1-9]\d*` numeric identifier; an optional leading `v` is allowed.
    #   - **Parse on trim.** Callers parse `value.strip`; {.parse} also trims.
    #   - **Unparseable → nil**, never an exception. The caller treats nil as a
    #     validation error (the rule errors and does not match — FR-010), NOT a
    #     silent false.
    #   - **Precedence**: numeric major.minor.patch first; then pre-release. A
    #     version WITHOUT a pre-release ranks HIGHER than one WITH a pre-release.
    #     Pre-release identifiers compared field-by-field — numeric vs numeric
    #     numerically; a numeric identifier < an alphanumeric identifier;
    #     alphanumeric compared ASCII-lexically; when all preceding fields are
    #     equal, MORE fields rank higher than fewer.
    #   - **Build metadata is ignored** for precedence (SemVer §10).
    module Semver
      NUMERIC_IDENTIFIER = '0|[1-9]\d*'
      NON_NUMERIC_IDENTIFIER = '\d*[a-zA-Z-][a-zA-Z0-9-]*'
      MAIN_VERSION = "(#{NUMERIC_IDENTIFIER})\\.(#{NUMERIC_IDENTIFIER})\\.(#{NUMERIC_IDENTIFIER})".freeze
      PRERELEASE_IDENTIFIER = "(?:#{NUMERIC_IDENTIFIER}|#{NON_NUMERIC_IDENTIFIER})".freeze
      PRERELEASE = "(?:-(#{PRERELEASE_IDENTIFIER}(?:\\.#{PRERELEASE_IDENTIFIER})*))".freeze
      BUILD_IDENTIFIER = "[0-9A-Za-z-]+"
      BUILD = "(?:\\+(#{BUILD_IDENTIFIER}(?:\\.#{BUILD_IDENTIFIER})*))".freeze
      FULL = /\Av?#{MAIN_VERSION}#{PRERELEASE}?#{BUILD}?\z/

      MAX_LENGTH = 256
      # Mirrors JS Number.MAX_SAFE_INTEGER (the TS reference's bound).
      MAX_SAFE_INTEGER = 9_007_199_254_740_991

      NUMERIC_RE = /\A[0-9]+\z/

      # A parsed semver with a ConfigCat-precedence #compare.
      #
      # `prerelease` is an Array of Integer (numeric ids) | String;
      # `build` is an Array of String (ignored for precedence).
      Version = Struct.new(:version, :major, :minor, :patch, :prerelease, :build, keyword_init: true) do
        # Compare against `other`: <0 lower, 0 equal, >0 higher. Build metadata
        # is ignored. Mirrors common-js `SemVer.compare` → `compareMain ||
        # comparePre`.
        def compare(other)
          return 0 if other.version == version

          main = compare_main(other)
          return main unless main.zero?

          compare_pre(other)
        end

        private

        def compare_main(other)
          c = Semver.compare_identifiers(major, other.major)
          return c unless c.zero?

          c = Semver.compare_identifiers(minor, other.minor)
          return c unless c.zero?

          Semver.compare_identifiers(patch, other.patch)
        end

        def compare_pre(other)
          # A version WITHOUT a pre-release is higher-precedence than one WITH.
          return -1 if !prerelease.empty? && other.prerelease.empty?
          return 1 if prerelease.empty? && !other.prerelease.empty?
          return 0 if prerelease.empty? && other.prerelease.empty?

          i = 0
          loop do
            a = i < prerelease.length ? prerelease[i] : nil
            b = i < other.prerelease.length ? other.prerelease[i] : nil
            return 0 if a.nil? && b.nil?
            return 1 if b.nil?
            return -1 if a.nil?

            if a == b
              i += 1
              next
            end
            return Semver.compare_identifiers(a, b)
          end
        end
      end

      module_function

      # Compare two pre-release / core identifiers (common-js
      # `compareIdentifiers`): both numeric → numeric compare; a numeric
      # identifier is lower-precedence than an alphanumeric one; otherwise
      # ASCII-lexical.
      def compare_identifiers(a, b)
        anum = !NUMERIC_RE.match(a.to_s).nil?
        bnum = !NUMERIC_RE.match(b.to_s).nil?
        av = a
        bv = b
        if anum && bnum
          av = a.to_i
          bv = b.to_i
        end
        return 0 if av == bv
        return -1 if anum && !bnum
        return 1 if bnum && !anum

        av < bv ? -1 : 1
      end

      # Parse a version string under ConfigCat's strict grammar. Returns nil on
      # any failure (length, grammar, out-of-range core component) — never
      # raises. Trims the input first (parse on trim). The caller surfaces nil
      # as a validation error (FR-010), never a silent match.
      def parse(version)
        trimmed = version.strip
        return nil if trimmed.length > MAX_LENGTH

        m = FULL.match(trimmed)
        return nil if m.nil?

        major = m[1].to_i
        minor = m[2].to_i
        patch = m[3].to_i
        return nil if major.negative? || major > MAX_SAFE_INTEGER
        return nil if minor.negative? || minor > MAX_SAFE_INTEGER
        return nil if patch.negative? || patch > MAX_SAFE_INTEGER

        prerelease = parse_prerelease(m[4])
        build = m[5] ? m[5].split(".") : []

        canonical = "#{major}.#{minor}.#{patch}"
        canonical += "-#{prerelease.join(".")}" unless prerelease.empty?
        Version.new(
          version: canonical,
          major: major, minor: minor, patch: patch,
          prerelease: prerelease, build: build
        )
      end

      # Numberify numeric pre-release ids (matching common-js).
      def parse_prerelease(raw)
        return [] if raw.nil?

        raw.split(".").map do |ident|
          if NUMERIC_RE.match(ident)
            num = ident.to_i
            next num if num >= 0 && num < MAX_SAFE_INTEGER
          end
          ident
        end
      end
    end
  end
end
