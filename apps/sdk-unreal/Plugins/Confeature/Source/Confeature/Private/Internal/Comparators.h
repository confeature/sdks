// SPDX-License-Identifier: MIT
#pragma once

// The 36 ConfigCat `UserComparator` operations + attribute conversion
// (spec 131, re-ported field-for-field from the corpus-verified C++ port
// `apps/sdk-cpp/src/internal/comparators.cpp`, which ports
// `packages/sdk-shared/src/comparators.ts`).
//
// Each comparator yields a boolean match; the conversion entrypoints yield a
// three-valued result (ok + value, or a validation error message). A
// validation / conversion failure (bad semver, non-numeric number, non-array
// array) short-circuits the AND group like no-match but is surfaced rather
// than silently swallowed (FR-010).
//
// Attribute values reach the comparator functions already as text (the
// evaluator owns missing-attribute / no-user gates). The corpus user feeds
// custom attributes through the comparator conversion path; native numbers /
// arrays / epochs arrive pre-stringified at the caller, so the conversion
// entrypoints accept the string form.

#include "CoreMinimal.h"

namespace Confeature::Internal
{
	// UserComparator discriminators (mirror config-json.ts UserComparator).
	enum EUserComparator : int32
	{
		ComparatorTextIsOneOf = 0,
		ComparatorTextIsNotOneOf = 1,
		ComparatorTextContainsAnyOf = 2,
		ComparatorTextNotContainsAnyOf = 3,
		ComparatorSemVerIsOneOf = 4,
		ComparatorSemVerIsNotOneOf = 5,
		ComparatorSemVerLess = 6,
		ComparatorSemVerLessOrEquals = 7,
		ComparatorSemVerGreater = 8,
		ComparatorSemVerGreaterOrEquals = 9,
		ComparatorNumberEquals = 10,
		ComparatorNumberNotEquals = 11,
		ComparatorNumberLess = 12,
		ComparatorNumberLessOrEquals = 13,
		ComparatorNumberGreater = 14,
		ComparatorNumberGreaterOrEquals = 15,
		ComparatorSensitiveTextIsOneOf = 16,
		ComparatorSensitiveTextIsNotOneOf = 17,
		ComparatorDateTimeBefore = 18,
		ComparatorDateTimeAfter = 19,
		ComparatorSensitiveTextEquals = 20,
		ComparatorSensitiveTextNotEquals = 21,
		ComparatorSensitiveTextStartsWithAnyOf = 22,
		ComparatorSensitiveTextNotStartsWithAnyOf = 23,
		ComparatorSensitiveTextEndsWithAnyOf = 24,
		ComparatorSensitiveTextNotEndsWithAnyOf = 25,
		ComparatorSensitiveArrayContainsAnyOf = 26,
		ComparatorSensitiveArrayNotContainsAnyOf = 27,
		ComparatorTextEquals = 28,
		ComparatorTextNotEquals = 29,
		ComparatorTextStartsWithAnyOf = 30,
		ComparatorTextNotStartsWithAnyOf = 31,
		ComparatorTextEndsWithAnyOf = 32,
		ComparatorTextNotEndsWithAnyOf = 33,
		ComparatorArrayContainsAnyOf = 34,
		ComparatorArrayNotContainsAnyOf = 35,
	};

	// Conversion result: ok + typed value, or a validation error message.
	struct FNumberConvert
	{
		bool bOk = false;
		double Value = 0.0;
		FString Error;
	};
	struct FArrayConvert
	{
		bool bOk = false;
		TArray<FString> Value;
		FString Error;
	};

	// ── Text (cleartext, case-sensitive, no trim) ──────────────────────────
	bool TextEquals(const FString& Text, const FString& ComparisonValue, bool bNegate);
	bool TextIsOneOf(const FString& Text, const TArray<FString>& Values, bool bNegate);
	bool TextContainsAnyOf(const FString& Text, const TArray<FString>& Values, bool bNegate);
	bool TextSliceEqualsAnyOf(
		const FString& Text, const TArray<FString>& Values, bool bStartsWith, bool bNegate);

	// ── Sensitive text (SHA-256 salted) ────────────────────────────────────
	bool SensitiveTextEquals(const FString& Text, const FString& ComparisonValue,
		const FString& ConfigSalt, const FString& ContextSalt, bool bNegate);
	bool SensitiveTextIsOneOf(const FString& Text, const TArray<FString>& Values,
		const FString& ConfigSalt, const FString& ContextSalt, bool bNegate);
	bool SensitiveTextSliceEqualsAnyOf(const FString& Text, const TArray<FString>& Values,
		const FString& ConfigSalt, const FString& ContextSalt, bool bStartsWith, bool bNegate);

	// ── Semver ───────────────────────────────────────────────────────────────
	bool SemVerIsOneOf(const FString& Version, const TArray<FString>& Values, bool bNegate);
	bool SemVerRelation(const FString& Version, int32 Comparator, const FString& ComparisonValue);

	// ── Number ─────────────────────────────────────────────────────────────
	bool NumberRelation(double Num, int32 Comparator, double ComparisonValue);

	// ── Datetime (Unix seconds) ──────────────────────────────────────────────
	bool DateTimeRelation(double Seconds, double ComparisonValue, bool bBefore);

	// ── Array (cleartext + sensitive) ──────────────────────────────────────
	bool ArrayContainsAnyOf(
		const TArray<FString>& Array, const TArray<FString>& Values, bool bNegate);
	bool SensitiveArrayContainsAnyOf(const TArray<FString>& Array, const TArray<FString>& Values,
		const FString& ConfigSalt, const FString& ContextSalt, bool bNegate);

	// ── Attribute conversion (string → typed) with validation outcome ──────
	// Strict whole-string float parse (common-js parseFloatStrict), `,`→`.`
	// applied by the caller. Rejects empty / leading-zero-octal / trailing
	// garbage.
	bool ParseFloatStrict(const FString& Value, double& Out);

	FNumberConvert AttributeAsNumber(const FString& Attr, const FString& Value);
	FNumberConvert AttributeAsUnixTimeSeconds(const FString& Attr, const FString& Value);
	FArrayConvert AttributeAsStringArray(const FString& Attr, const FString& Value);
}
