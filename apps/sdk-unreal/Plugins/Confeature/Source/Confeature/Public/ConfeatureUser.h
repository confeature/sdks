// SPDX-License-Identifier: MIT
#pragma once

// `FConfeatureUser` mirrors ConfigCat-cpp's `ConfigCatUser` targeting
// object, adapted to UE's `USTRUCT(BlueprintType)` convention so it can
// be passed to / from Blueprint nodes. It surfaces the four canonical
// attributes (Identifier, Email, Country, Custom).
//
// ── Typed custom attributes (spec 151 / #468 US2) ─────────────────────────
//
// configcat-cpp's `ConfigCatUser` carries TYPED custom attributes:
//
//   using AttributeValue =
//       std::variant<std::string, double, date_time_t, std::vector<std::string>>;
//
// UE's reflection (`UPROPERTY`) can't express a `std::variant` / tagged
// union directly, so we adopt ConfigCat's official UE-style surface
// (Principle II, documented-checklist fallback): the Blueprint-visible
// `Custom` STRING map is preserved verbatim (no regression, Blueprint
// friendly), and a parallel C++-only TYPED store
// (`FConfeatureUserAttribute`) mirrors configcat-cpp's `AttributeValue`
// 1:1. Typed values are added via the `SetCustom*` helpers; the string
// path keeps populating BOTH stores so existing `Custom`-only callers are
// unaffected.
//
// A non-string typed attribute is canonicalised to its ConfigCat-exact
// text form by the evaluator at comparison time
// (mirrors apps/sdk-cpp/src/internal/evaluator.cpp::userAttributeValueToString):
//   - number      → ECMAScript `Number.toString` (invariant decimal / exponent)
//   - FDateTime   → Unix **seconds** (fractional; ConfigCat `getTime()/1000`)
//   - TArray<FString> (string array) → compact `JSON.stringify`
// A string attribute is used verbatim.

#include "CoreMinimal.h"

#include "ConfeatureUser.generated.h"

// Discriminator for `FConfeatureUserAttribute`, mirroring the four
// alternatives of configcat-cpp's `ConfigCatUser::AttributeValue`
// variant: string / double / date_time_t / string array. (Numbers are
// `double` only — there is deliberately no integer variant, exactly as
// in configcat-cpp.)
UENUM()
enum class EConfeatureUserAttributeKind : uint8
{
	// A plain text attribute, used verbatim by the evaluator.
	String,
	// A numeric attribute (double). Canonicalised to ECMAScript
	// `Number.toString` at comparison time.
	Number,
	// A date/time attribute. Canonicalised to Unix epoch SECONDS
	// (fractional) at comparison time.
	DateTime,
	// A string-array attribute. Canonicalised to a compact JSON array
	// string at comparison time.
	StringArray,
};

// Typed custom-attribute value — the UE-C++ analogue of configcat-cpp's
// `ConfigCatUser::AttributeValue` (a `std::variant`). UE doesn't ship
// `std::variant`; this tagged struct is the idiomatic equivalent. The
// active alternative is identified by `Kind`; the inactive slots carry
// zero-values. Not a `USTRUCT` because it holds no Blueprint-exposable
// union — it lives only in the C++ targeting path alongside the
// Blueprint-visible `Custom` string map.
struct FConfeatureUserAttribute
{
	EConfeatureUserAttributeKind Kind = EConfeatureUserAttributeKind::String;

	FString StringValue;
	double NumberValue = 0.0;
	// Stored as the number of seconds (fractional) since the Unix epoch so
	// the canonical conversion is exact regardless of FDateTime's internal
	// 0.1-microsecond tick resolution. The evaluator renders this verbatim
	// as epoch seconds.
	double DateTimeEpochSeconds = 0.0;
	TArray<FString> StringArrayValue;

	FConfeatureUserAttribute() = default;

	static FConfeatureUserAttribute MakeString(FString V)
	{
		FConfeatureUserAttribute A;
		A.Kind = EConfeatureUserAttributeKind::String;
		A.StringValue = MoveTemp(V);
		return A;
	}
	static FConfeatureUserAttribute MakeNumber(double V)
	{
		FConfeatureUserAttribute A;
		A.Kind = EConfeatureUserAttributeKind::Number;
		A.NumberValue = V;
		return A;
	}
	// Build from a UE `FDateTime`. ConfigCat date attributes are compared as
	// Unix epoch seconds, so we convert through Unix time. `FDateTime`'s
	// `ToUnixTimestampDecimal()` (UE 5.3+) yields fractional seconds.
	static FConfeatureUserAttribute MakeDateTime(const FDateTime& V)
	{
		FConfeatureUserAttribute A;
		A.Kind = EConfeatureUserAttributeKind::DateTime;
		// FDateTime ticks are 100-nanosecond intervals since 0001-01-01;
		// subtract the Unix epoch and scale to seconds (fractional).
		const int64 UnixTicks = (V - FDateTime::FromUnixTimestamp(0)).GetTicks();
		A.DateTimeEpochSeconds = static_cast<double>(UnixTicks) / static_cast<double>(ETimespan::TicksPerSecond);
		return A;
	}
	// Build directly from a fractional Unix-epoch-seconds value (the form
	// the parity corpus `{"$date": <epoch-seconds>}` encoding carries, and
	// the most precision-preserving path for a date attribute).
	static FConfeatureUserAttribute MakeDateTimeFromEpochSeconds(double EpochSeconds)
	{
		FConfeatureUserAttribute A;
		A.Kind = EConfeatureUserAttributeKind::DateTime;
		A.DateTimeEpochSeconds = EpochSeconds;
		return A;
	}
	static FConfeatureUserAttribute MakeStringArray(TArray<FString> V)
	{
		FConfeatureUserAttribute A;
		A.Kind = EConfeatureUserAttributeKind::StringArray;
		A.StringArrayValue = MoveTemp(V);
		return A;
	}
};

USTRUCT(BlueprintType)
struct CONFEATURE_API FConfeatureUser
{
	GENERATED_BODY()

	// Stable per-user identifier. Treated as opaque by the evaluator;
	// targeting rules reference it as `User.Identifier`.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	FString Identifier;

	// Optional e-mail attribute. Surfaces as `User.Email` to targeting
	// rules.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	FString Email;

	// Optional country / region attribute (typically an ISO-3166
	// alpha-2 code, but the evaluator treats it as an opaque string).
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	FString Country;

	// Free-form STRING attribute bag (Blueprint-visible). Keys are
	// case-sensitive. Values are plain strings, used verbatim by the
	// evaluator. For TYPED attributes (number / date / string-array) use
	// the `SetCustom*` helpers below — they keep this map and the typed
	// store in sync.
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Confeature")
	TMap<FString, FString> Custom;

	// ── typed custom-attribute store (configcat-cpp parity) ───────────────
	// C++-only mirror of `Custom`, carrying the attribute's natural type so
	// the evaluator can canonicalise non-string values ConfigCat-exactly
	// (number → invariant decimal, date → epoch seconds, array → JSON). A
	// string attribute lives in BOTH `Custom` and here; a typed attribute
	// lives only here. The evaluator consults this store first, falling
	// back to `Custom` for any string-only entry. Not a `UPROPERTY` — it
	// holds no Blueprint-exposable union.
	TMap<FString, FConfeatureUserAttribute> TypedCustom;

	// ── typed setters (mirror configcat-cpp's `ConfigCatUser` overloads) ──
	// Every setter routes into `TypedCustom`. `SetCustomString` ALSO keeps
	// the Blueprint `Custom` map populated so a string attribute remains
	// readable through the legacy map path (no regression).
	FConfeatureUser& SetCustomString(const FString& Key, const FString& Value)
	{
		Custom.Add(Key, Value);
		TypedCustom.Add(Key, FConfeatureUserAttribute::MakeString(Value));
		return *this;
	}
	FConfeatureUser& SetCustomNumber(const FString& Key, double Value)
	{
		TypedCustom.Add(Key, FConfeatureUserAttribute::MakeNumber(Value));
		return *this;
	}
	FConfeatureUser& SetCustomDateTime(const FString& Key, const FDateTime& Value)
	{
		TypedCustom.Add(Key, FConfeatureUserAttribute::MakeDateTime(Value));
		return *this;
	}
	FConfeatureUser& SetCustomDateTimeFromEpochSeconds(const FString& Key, double EpochSeconds)
	{
		TypedCustom.Add(Key, FConfeatureUserAttribute::MakeDateTimeFromEpochSeconds(EpochSeconds));
		return *this;
	}
	FConfeatureUser& SetCustomStringArray(const FString& Key, const TArray<FString>& Value)
	{
		TypedCustom.Add(Key, FConfeatureUserAttribute::MakeStringArray(Value));
		return *this;
	}
};
