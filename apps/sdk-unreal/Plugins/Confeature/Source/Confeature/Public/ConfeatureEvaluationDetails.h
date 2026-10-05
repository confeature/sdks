// SPDX-License-Identifier: MIT
#pragma once

// Spec 085 / #266 + spec 152 / #475 — evaluation-details envelope.
//
// `FConfeatureEvaluationDetails` mirrors the shape exposed by upstream
// `configcat-cpp` v4 (`configcat::EvaluationDetails<T>`) and the sdk-cpp
// federation port (`apps/sdk-cpp/include/confeature/evaluation_details.h`).
// A migrating consumer reads `Key`, `Value*`, `Error`, `VariationId`,
// `bIsDefaultValue` off the same field names + types (adapted to UE
// `FString` / `UCLASS` conventions).
//
// UE Blueprint nodes cannot dispatch on template type parameters, so —
// exactly like the per-primitive `GetValue*` overloads — the resolved
// value is carried in per-primitive slots (`bValue` / `StringValue` /
// `IntValue` / `DoubleValue`). The active slot matches the typed
// `GetValueDetails*` accessor the caller invoked; the others carry the
// supplied default. This is the UE-idiomatic equivalent of the C++
// `EvaluationDetails<T>::value` member.

#include "CoreMinimal.h"

#include "ConfeatureUser.h"

#include "ConfeatureEvaluationDetails.generated.h"

// Evaluation envelope returned by the `UConfeatureClient::GetValueDetails*`
// surface. Field semantics mirror `configcat::EvaluationDetails<T>` /
// the sdk-cpp `EvaluationDetails<T>`:
//   - `Key`              — the flag key requested.
//   - `bValue` / `StringValue` / `IntValue` / `DoubleValue` — the resolved
//                          value in the slot matching the typed accessor,
//                          or `DefaultValue` on any failure.
//   - `VariationId`      — variation ID (`v.i`); empty on every fail path
//                          and on flat-map (value-only) override hits.
//                          POPULATED on the full-config override path +
//                          cache hits (spec 152 / #475 — the #395 fix).
//   - `bHasVariationId`  — false when no variation ID was resolved
//                          (the UE-idiomatic mirror of C++
//                          `std::optional<std::string>` being `nullopt`).
//   - `bIsDefaultValue`  — true whenever the resolver fell back to
//                          `DefaultValue` (every error branch, every
//                          closed-client read).
//   - `Error`            — error code string (e.g. `KEY_NOT_FOUND`,
//                          `TYPE_MISMATCH`, `CLIENT_CLOSED`) or empty on
//                          success.
//   - `User`             — the user supplied to the call (or the
//                          builder-configured default user).
USTRUCT(BlueprintType)
struct CONFEATURE_API FConfeatureEvaluationDetails
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FString Key;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	bool bValue = false;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FString StringValue;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	int32 IntValue = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	double DoubleValue = 0.0;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FString VariationId;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	bool bHasVariationId = false;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	bool bIsDefaultValue = false;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FString Error;

	UPROPERTY(BlueprintReadOnly, Category = "Confeature")
	FConfeatureUser User;
};
