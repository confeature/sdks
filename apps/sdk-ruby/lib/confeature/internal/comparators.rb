# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "json"
require "date"
require_relative "hashing"
require_relative "semver"

module Confeature
  module Internal
    # The 36 ConfigCat `UserComparator` operations + attribute conversion.
    # Ported field-for-field from the spec-117 TS reference
    # (`packages/sdk-shared/src/comparators.ts`) and the spec-118 Python port
    # (`apps/sdk-python/.../comparators.py`), itself verified against common-js
    # `RolloutEvaluator.ts` (`configcat-common@9.4.1`).
    #
    # Each comparator returns a three-valued outcome: `true` (match), `false`
    # (no match), or a `ValidationError` (a validation / conversion failure —
    # bad semver, non-numeric number, non-array array). An error short-circuits
    # the AND group like `false` but is surfaced rather than silently swallowed
    # (FR-010).
    #
    # The six families: text (cleartext, case-SENSITIVE, no trim); sensitive
    # text (SHA-256 SALTED, length-prefixed slice variants); semver (on
    # `Semver.parse`); number (strict whole-string parse, `,`→`.`); datetime
    # (Before/After, Unix seconds); array (contains/notContains, cleartext +
    # sensitive).
    module Comparators
      # UserComparator discriminators (mirror config-json.ts UserComparator).
      TEXT_IS_ONE_OF = 0
      TEXT_IS_NOT_ONE_OF = 1
      TEXT_CONTAINS_ANY_OF = 2
      TEXT_NOT_CONTAINS_ANY_OF = 3
      SEMVER_IS_ONE_OF = 4
      SEMVER_IS_NOT_ONE_OF = 5
      SEMVER_LESS = 6
      SEMVER_LESS_OR_EQUALS = 7
      SEMVER_GREATER = 8
      SEMVER_GREATER_OR_EQUALS = 9
      NUMBER_EQUALS = 10
      NUMBER_NOT_EQUALS = 11
      NUMBER_LESS = 12
      NUMBER_LESS_OR_EQUALS = 13
      NUMBER_GREATER = 14
      NUMBER_GREATER_OR_EQUALS = 15
      SENSITIVE_TEXT_IS_ONE_OF = 16
      SENSITIVE_TEXT_IS_NOT_ONE_OF = 17
      DATETIME_BEFORE = 18
      DATETIME_AFTER = 19
      SENSITIVE_TEXT_EQUALS = 20
      SENSITIVE_TEXT_NOT_EQUALS = 21
      SENSITIVE_TEXT_STARTS_WITH_ANY_OF = 22
      SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF = 23
      SENSITIVE_TEXT_ENDS_WITH_ANY_OF = 24
      SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF = 25
      SENSITIVE_ARRAY_CONTAINS_ANY_OF = 26
      SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF = 27
      TEXT_EQUALS = 28
      TEXT_NOT_EQUALS = 29
      TEXT_STARTS_WITH_ANY_OF = 30
      TEXT_NOT_STARTS_WITH_ANY_OF = 31
      TEXT_ENDS_WITH_ANY_OF = 32
      TEXT_NOT_ENDS_WITH_ANY_OF = 33
      ARRAY_CONTAINS_ANY_OF = 34
      ARRAY_NOT_CONTAINS_ANY_OF = 35

      # A validation / conversion failure outcome (surfaced, not silent).
      # The condition dispatch returns one of these instead of `true`/`false`
      # when a typed-attribute conversion fails (FR-010).
      ValidationError = Struct.new(:message)

      # A malformed CONFIG comparison value (#509). configcat-common validates
      # the operand BEFORE the user attribute for the semver relations, number
      # relations, and datetime comparators; a malformed operand surfaces this
      # distinct `comparison value '<v>' is invalid (<reason>)` outcome (NO
      # "please check the User.<attr>…" suffix — the fault is in the config, not
      # the user), which wins even when the attribute is ALSO malformed. It
      # short-circuits the AND group like `false`. A distinct subclass so the
      # evaluator routes it to the WARN 3004 `comparisonValueIsInvalid` site.
      class ComparisonValueError < ValidationError; end

      module_function

      def error(message)
        ValidationError.new(message)
      end

      def comparison_value_error(value, reason)
        ComparisonValueError.new("comparison value '#{value}' is invalid (#{reason})")
      end

      # Config semver operand → semver, or a comparison-value error. The operand
      # is trimmed before parsing (parity with `evaluate_semver_relation`); the
      # error reports the UNTRIMMED operand.
      def comparison_value_as_semver(value)
        version = Semver.parse(value.strip)
        return version unless version.nil?

        comparison_value_error(value, "'#{value}' is not a valid semantic version")
      end

      # Render a numeric operand for the comparison-value error message. Mirrors
      # TS's `String(value)`: an absent operand prints "undefined", otherwise the
      # canonical number string.
      def comparison_value_number_string(value)
        return "undefined" if value.nil?

        number_to_canonical_string(value)
      end

      # Config number operand → number, or a comparison-value error. `value` is
      # the condition's `d` slot (nil when absent).
      def comparison_value_as_number(value)
        return value if !value.nil? && !value.to_f.nan?

        s = comparison_value_number_string(value)
        comparison_value_error(s, "'#{s}' is not a valid decimal number")
      end

      # Config datetime operand → Unix seconds, or a comparison-value error.
      def comparison_value_as_unix_time_seconds(value)
        return value if !value.nil? && !value.to_f.nan?

        s = comparison_value_number_string(value)
        comparison_value_error(
          s,
          "'#{s}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"
        )
      end

      def string_array?(value)
        value.is_a?(Array) && value.all?(String)
      end

      # Convert a `Time` / `DateTime` to a second-based Unix timestamp
      # (fractional seconds preserved). Mirrors upstream `configcat-ruby`'s
      # datetime → epoch-seconds conversion and the Python port's
      # `datetime_to_seconds_since_epoch`: a naive `DateTime` (no offset) is
      # treated as UTC. `1680307199.999` round-trips exactly.
      def datetime_to_seconds_since_epoch(value)
        if value.is_a?(::Time)
          value.to_r.to_f
        else
          # `DateTime#to_time` honours the offset; a naive DateTime is assumed
          # UTC by Date/Time, matching the upstream "naive → UTC" rule.
          value.to_time.to_r.to_f
        end
      end

      def datetime?(value)
        value.is_a?(::Time) || value.is_a?(::DateTime)
      end

      # Stringify a user-attribute value (common-js `userAttributeValueToString`).
      # String verbatim; bool → "true"/"false" (JS lowercase); datetime → its
      # second-based Unix timestamp rendered as a canonical number (checked
      # before the numeric branch so a Date renders as its epoch seconds —
      # upstream parity); string array → JSON.stringify (compact, comma+colon
      # separators); number → JS canonical string; else `to_s`.
      def user_attribute_value_to_string(value)
        return value if value.is_a?(String)
        return value ? "true" : "false" if [true, false].include?(value)
        return number_to_canonical_string(datetime_to_seconds_since_epoch(value)) if datetime?(value)
        return JSON.generate(value) if string_array?(value)
        return number_to_canonical_string(value) if value.is_a?(Numeric)

        value.to_s
      end

      # Stringify a number as ConfigCat's canonical string (JS `Number::toString`).
      # NaN / ±Infinity print as "NaN" / "Infinity" / "-Infinity"; otherwise the
      # SHORTEST round-tripping digit sequence, fixed-point unless the magnitude
      # warrants exponential. The corpus `numberToStringConversion*` cases hinge
      # on this — e.g. `-1.23456789e+96` must NOT expand to its full integer form.
      def number_to_canonical_string(value)
        f = value.to_f
        return "NaN" if f.nan?
        return f.positive? ? "Infinity" : "-Infinity" if f.infinite?
        return "0" if f.zero?

        js_number_to_string(f)
      end

      # Render a finite non-zero float exactly as ECMAScript `Number::toString`.
      def js_number_to_string(value)
        sign = value.negative? ? "-" : ""
        av = value.abs
        digits, point = shortest_digits_and_point(av)
        k = digits.length
        n = point

        if n.between?(k, 21)
          sign + digits + ("0" * (n - k))
        elsif n.positive? && n <= 21
          "#{sign}#{digits[0, n]}.#{digits[n..]}"
        elsif n > -6 && n <= 0
          "#{sign}0.#{"0" * (-n)}#{digits}"
        else
          e = n - 1
          exp_sign = e >= 0 ? "+" : "-"
          mant = k == 1 ? digits[0] : "#{digits[0]}.#{digits[1..]}"
          "#{sign}#{mant}e#{exp_sign}#{e.abs}"
        end
      end

      # Decompose the shortest round-tripping repr of a positive float into
      # (digits, point) — `point` = the count of significant digits before the
      # decimal point in normalized form (the ECMAScript `n`). Ruby's
      # `Float#to_s` gives the shortest round-tripping representation.
      def shortest_digits_and_point(av)
        shortest = av.to_s
        if shortest.include?("e") || shortest.include?("E")
          mant, _, exp = shortest.downcase.partition("e")
          exp_val = exp.to_i
        else
          mant = shortest
          exp_val = 0
        end
        if mant.include?(".")
          int_part, frac_part = mant.split(".")
        else
          int_part = mant
          frac_part = ""
        end
        raw = int_part + frac_part
        point = int_part.length + exp_val
        # Strip leading zeros (adjusting point), then trailing zeros.
        lead = 0
        while lead < raw.length - 1 && raw[lead] == "0"
          lead += 1
          point -= 1
        end
        raw = raw[lead..]
        raw = raw.sub(/0+\z/, "")
        raw = "0" if raw.empty?
        [raw, point]
      end

      # Strict whole-string float parse (common-js `parseFloatStrict`). Rejects
      # empty / all-whitespace and a leading `0` followed by a non-digit/non-`.`/
      # non-`e` (octal / hex). Returns Float::NAN on rejection. JS's `parseFloat`
      # is too forgiving (prefix parse), so "12abc" is NaN.
      def parse_float_strict(value)
        return Float::NAN if value.empty? || value =~ /\A\s*\z|\A\s*0[^\d.eE]/

        # JS `+value` accepts "Infinity"/"-Infinity" and full-string floats only.
        stripped = value.strip
        return Float::INFINITY if stripped == "Infinity"
        return -Float::INFINITY if stripped == "-Infinity"
        return Float::NAN if stripped == "NaN"
        return Float::NAN unless stripped =~ /\A[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\z/

        Float(stripped)
      rescue ArgumentError, TypeError
        Float::NAN
      end

      # -----------------------------------------------------------------------
      # Text — cleartext (case-sensitive, no trim)
      # -----------------------------------------------------------------------

      def evaluate_text_equals(text, comparison_value, negate)
        (text == comparison_value) != negate
      end

      def evaluate_text_is_one_of(text, comparison_values, negate)
        comparison_values.include?(text) != negate
      end

      def evaluate_text_contains_any_of(text, comparison_values, negate)
        comparison_values.each { |item| return !negate if text.include?(item) }
        negate
      end

      # Cleartext startsWith/endsWith-any-of. Items longer than text are skipped.
      def evaluate_text_slice_equals_any_of(text, comparison_values, starts_with, negate)
        comparison_values.each do |item|
          next if text.length < item.length

          matched = starts_with ? text.start_with?(item) : text.end_with?(item)
          return !negate if matched
        end
        negate
      end

      # -----------------------------------------------------------------------
      # Text — sensitive (SHA-256 salted)
      # -----------------------------------------------------------------------

      def evaluate_sensitive_text_equals(text, comparison_value, config_salt, context_salt, negate)
        h = Hashing.hash_comparison_value(text, config_salt, context_salt)
        (h == comparison_value) != negate
      end

      def evaluate_sensitive_text_is_one_of(text, comparison_values, config_salt, context_salt, negate)
        h = Hashing.hash_comparison_value(text, config_salt, context_salt)
        comparison_values.include?(h) != negate
      end

      # Sensitive startsWith/endsWith-any-of. Each operand is "<byteLen>_<hash>";
      # the SDK hashes the matching-length BYTE prefix/suffix of the attribute
      # and compares to <hash>. Slicing is over the UTF-8 byte sequence (not code
      # points), matching common-js.
      def evaluate_sensitive_text_slice_equals_any_of(
        text, comparison_values, config_salt, context_salt, starts_with, negate
      )
        text_utf8 = text.encode(Encoding::UTF_8).b
        comparison_values.each do |item|
          index = item.index("_")
          next if index.nil?

          slice_length = Integer(item[0, index], exception: false)
          next if slice_length.nil?
          next if text_utf8.bytesize < slice_length

          slice_utf8 =
            if starts_with
              text_utf8[0, slice_length]
            else
              text_utf8[text_utf8.bytesize - slice_length, slice_length]
            end
          h = Hashing.hash_comparison_value_slice(slice_utf8, config_salt, context_salt)
          return !negate if h == item[(index + 1)..]
        end
        negate
      end

      # -----------------------------------------------------------------------
      # Semver
      # -----------------------------------------------------------------------

      # Semver IS-ONE-OF / IS-NOT-ONE-OF (comparators 4/5). Each operand is
      # trimmed first; an operand that is empty AFTER trimming (incl.
      # whitespace-only) is skipped — matching ConfigCat, which trims before the
      # empty check. A non-empty but unparseable operand makes the whole
      # comparator `false` (backward-compat). Iterates ALL operands (no
      # early-out on match).
      def evaluate_semver_is_one_of(version, comparison_values, negate)
        result = false
        comparison_values.each do |item|
          item = item.strip
          next if item.empty?

          version2 = Semver.parse(item)
          return false if version2.nil?

          result = true if !result && version.compare(version2).zero?
        end
        result != negate
      end

      # Semver relations (comparators 6-9). Unparseable operand -> `false`.
      def evaluate_semver_relation(version, comparator, comparison_value)
        version2 = Semver.parse(comparison_value.strip)
        return false if version2.nil?

        cmp = version.compare(version2)
        case comparator
        when SEMVER_LESS then cmp.negative?
        when SEMVER_LESS_OR_EQUALS then cmp <= 0
        when SEMVER_GREATER then cmp.positive?
        when SEMVER_GREATER_OR_EQUALS then cmp >= 0
        else false
        end
      end

      # -----------------------------------------------------------------------
      # Number
      # -----------------------------------------------------------------------

      def evaluate_number_relation(num, comparator, comparison_value)
        case comparator
        when NUMBER_EQUALS then num == comparison_value
        when NUMBER_NOT_EQUALS then num != comparison_value
        when NUMBER_LESS then num < comparison_value
        when NUMBER_LESS_OR_EQUALS then num <= comparison_value
        when NUMBER_GREATER then num > comparison_value
        when NUMBER_GREATER_OR_EQUALS then num >= comparison_value
        else false
        end
      end

      # -----------------------------------------------------------------------
      # Datetime (Unix seconds)
      # -----------------------------------------------------------------------

      def evaluate_datetime_relation(seconds, comparison_value, before)
        before ? seconds < comparison_value : seconds > comparison_value
      end

      # -----------------------------------------------------------------------
      # Array (cleartext + sensitive)
      # -----------------------------------------------------------------------

      def evaluate_array_contains_any_of(array, comparison_values, negate)
        array.each { |item| return !negate if comparison_values.include?(item) }
        negate
      end

      def evaluate_sensitive_array_contains_any_of(array, comparison_values, config_salt, context_salt, negate)
        array.each do |item|
          h = Hashing.hash_comparison_value(item, config_salt, context_salt)
          return !negate if comparison_values.include?(h)
        end
        negate
      end

      # -----------------------------------------------------------------------
      # Attribute → typed value, with three-valued error outcome (FR-010)
      # -----------------------------------------------------------------------

      def invalid_attr(attr, reason)
        error("cannot evaluate, the User.#{attr} attribute is invalid (#{reason})")
      end

      # Attribute → text (string verbatim; else stringified — never errors).
      def attribute_as_text(value)
        value.is_a?(String) ? value : user_attribute_value_to_string(value)
      end

      # Attribute → semver, or a validation error.
      def attribute_as_semver(attr, value)
        if value.is_a?(String)
          version = Semver.parse(value.strip)
          return version unless version.nil?
        end
        invalid_attr(attr, "'#{user_attribute_value_to_string(value)}' is not a valid semantic version")
      end

      # Attribute → number, or a validation error.
      def attribute_as_number(attr, value)
        return value.to_f if numeric_non_bool?(value)

        if value.is_a?(String)
          num = parse_float_strict(value.tr(",", "."))
          return num if !num.nan? || value.strip == "NaN"
        end
        invalid_attr(attr, "'#{user_attribute_value_to_string(value)}' is not a valid decimal number")
      end

      # Attribute → Unix seconds, or a validation error. A datetime attribute is
      # converted to fractional epoch seconds; a numeric attribute is already
      # seconds; a string is parsed strictly.
      def attribute_as_unix_time_seconds(attr, value)
        return datetime_to_seconds_since_epoch(value) if datetime?(value)
        return value.to_f if numeric_non_bool?(value)

        if value.is_a?(String)
          num = parse_float_strict(value.tr(",", "."))
          return num if !num.nan? || value.strip == "NaN"
        end
        invalid_attr(
          attr,
          "'#{user_attribute_value_to_string(value)}' is not a valid Unix timestamp " \
          "(number of seconds elapsed since Unix epoch)"
        )
      end

      # Attribute → string array, or a validation error. A string attribute is
      # JSON-parsed; the result must be a string array.
      def attribute_as_string_array(attr, value)
        arr = value
        if arr.is_a?(String)
          begin
            arr = JSON.parse(arr)
          rescue JSON::ParserError
            # A non-JSON string is simply not a valid array (matches common-js
            # no-op catch); falls through to the validation error below.
            arr = value
          end
        end
        return arr if string_array?(arr)

        invalid_attr(attr, "'#{user_attribute_value_to_string(value)}' is not a valid string array")
      end

      def numeric_non_bool?(value)
        value.is_a?(Numeric) && value != true && value != false
      end
    end
  end
end
