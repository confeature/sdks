// SPDX-License-Identifier: MIT

// API-surface conformance — documented checklist.
//
// ──────────────────────────────────────────────────────────────────────
// No official ConfigCat Unreal SDK exists. This test asserts the
// SDK's UFUNCTION surface against a documented checklist derived from
// the cross-SDK ConfigCat surface (boolean + string + int + double +
// control plane). This IS the conformance reference for Unreal — there
// is no upstream package to compare to.
// ──────────────────────────────────────────────────────────────────────
//
// Background — every Confeature SDK in the federation exposes the
// equivalent typed flag-read + control-plane surface:
//   - sdk-node, sdk-browser-js, sdk-bun, sdk-deno, sdk-cloudflare-worker
//   - sdk-react, sdk-angular
//   - sdk-java, sdk-android, sdk-kotlin-mp
//   - sdk-dotnet
//   - sdk-rust, sdk-go, sdk-cpp
//   - sdk-python, sdk-ruby, sdk-php, sdk-dart, sdk-elixir
//   - sdk-swift
//
// The Unreal checklist mirrors this cross-SDK contract via the
// per-primitive BlueprintCallable UFUNCTION pattern (Blueprint cannot
// dispatch on template parameters, so each primitive type gets its own
// UFUNCTION — analogous to UE's UDataTable::GetRow* family). The test
// reflects via UClass::FindFunctionByName + UFunction::GetReturnProperty
// + FProperty::GetClass to assert each entry is present and correctly
// typed. Drift-guard semantics: future audit corrections (if a checklist
// gap emerges) become their own follow-on specs; the test would fail
// loudly the day the gap closes.
//
// Spec 074 / Issue #261 / FR-006 / FR-007 / FR-020.
//
// Anchored 2026-05-23: the cross-SDK ConfigCat surface as the federation's
// SDKs exposed it that day, when this checklist was derived (constitution,
// Principle II: a documented checklist cites its derivation and its date).

#include "Misc/AutomationTest.h"
#include "UObject/Class.h"
#include "UObject/Field.h"
#include "UObject/UnrealType.h"

#include "ConfeatureClient.h"
#include "ConfeatureUser.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureApiSurfaceChecklistTest,
	"Confeature.ApiSurface.Checklist",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

namespace
{
	// Documented checklist entry. Captures the cross-SDK ConfigCat
	// contract per typed flag-read method + the control-plane methods.
	struct FChecklistEntry
	{
		FName FunctionName;
		// Expected return-property class. `nullptr` means the function
		// returns `void` (no FProperty for the return).
		FFieldClass* ExpectedReturnClass = nullptr;
		// Expected parameter property classes, in declaration order
		// (excluding the synthetic return parameter). Empty for the
		// control-plane methods.
		TArray<FFieldClass*> ExpectedParamClasses;
		// Whether the third parameter is the FConfeatureUser struct.
		// Used to assert FStructProperty::Struct == FConfeatureUser.
		bool bThirdParamIsConfeatureUser = false;
	};

	// Counts the non-return parameter properties of `Function`. UE's
	// UFunction stores parameters as FProperty children; the return
	// value (if any) is the property with CPF_ReturnParm set.
	int32 CountNonReturnParams(UFunction* Function)
	{
		int32 Count = 0;
		for (TFieldIterator<FProperty> It(Function); It; ++It)
		{
			if (!It->HasAnyPropertyFlags(CPF_ReturnParm))
			{
				++Count;
			}
		}
		return Count;
	}

	// Returns the n-th non-return parameter property (0-indexed), or
	// nullptr if out of range.
	FProperty* NthNonReturnParam(UFunction* Function, int32 N)
	{
		int32 Idx = 0;
		for (TFieldIterator<FProperty> It(Function); It; ++It)
		{
			if (It->HasAnyPropertyFlags(CPF_ReturnParm))
			{
				continue;
			}
			if (Idx == N)
			{
				return *It;
			}
			++Idx;
		}
		return nullptr;
	}
}

bool FConfeatureApiSurfaceChecklistTest::RunTest(const FString& /*Parameters*/)
{
	UClass* Cls = UConfeatureClient::StaticClass();
	if (!TestNotNull(TEXT("UConfeatureClient::StaticClass"), Cls))
	{
		return false;
	}

	// The documented checklist — derived from the cross-SDK ConfigCat
	// surface. Every entry is asserted against UConfeatureClient.
	const TArray<FChecklistEntry> Checklist = {
		// --- Typed flag-read surface ---------------------------------
		{ FName(TEXT("GetValueBool")), FBoolProperty::StaticClass(),
			{ FStrProperty::StaticClass(), FBoolProperty::StaticClass(),
				FStructProperty::StaticClass() },
			true },
		{ FName(TEXT("GetValueString")), FStrProperty::StaticClass(),
			{ FStrProperty::StaticClass(), FStrProperty::StaticClass(),
				FStructProperty::StaticClass() },
			true },
		{ FName(TEXT("GetValueInt")), FIntProperty::StaticClass(),
			{ FStrProperty::StaticClass(), FIntProperty::StaticClass(),
				FStructProperty::StaticClass() },
			true },
		{ FName(TEXT("GetValueFloat")), FFloatProperty::StaticClass(),
			{ FStrProperty::StaticClass(), FFloatProperty::StaticClass(),
				FStructProperty::StaticClass() },
			true },
		{ FName(TEXT("GetValueDouble")), FDoubleProperty::StaticClass(),
			{ FStrProperty::StaticClass(), FDoubleProperty::StaticClass(),
				FStructProperty::StaticClass() },
			true },
		// --- Control plane -------------------------------------------
		{ FName(TEXT("ForceRefresh")), FBoolProperty::StaticClass(), {}, false },
		// Close returns void → ExpectedReturnClass is nullptr.
		{ FName(TEXT("Close")), nullptr, {}, false },
		{ FName(TEXT("IsClosed")), FBoolProperty::StaticClass(), {}, false },
		// Spec 102 / #267 slice 14/14 — online/offline triplet landed.
		{ FName(TEXT("SetOnline")), nullptr, {}, false },
		{ FName(TEXT("SetOffline")), nullptr, {}, false },
		{ FName(TEXT("IsOffline")), FBoolProperty::StaticClass(), {}, false },
	};

	// --- Hooks / events surface (epic #574 / #577) --------------------
	//
	// ConfigCat's official Unreal SDK exposes a paired delegate API:
	// BLUEPRINT dynamic multicast delegates (BlueprintAssignable
	// UPROPERTYs, reflected here) + NATIVE C++ multicast delegates (plain
	// members, NOT reflected — asserted at compile time by the wiring in
	// ConfeatureClient.cpp). The checklist asserts the four Blueprint
	// delegate properties are PRESENT + are multicast-delegate properties.
	const TArray<FName> BlueprintHookDelegates = {
		FName(TEXT("OnClientReadyBp")),
		FName(TEXT("OnConfigChangedBp")),
		FName(TEXT("OnFlagEvaluatedBp")),
		FName(TEXT("OnErrorBp")),
	};

	UScriptStruct* ExpectedUserStruct = TBaseStructure<FConfeatureUser>::Get();
	TestNotNull(TEXT("FConfeatureUser::StaticStruct"), ExpectedUserStruct);

	bool bAllPassed = true;
	for (const FChecklistEntry& Entry : Checklist)
	{
		const FString EntryLabel = Entry.FunctionName.ToString();

		UFunction* Fn = Cls->FindFunctionByName(Entry.FunctionName);
		if (!TestNotNull(*FString::Printf(TEXT("Checklist entry present: %s"), *EntryLabel), Fn))
		{
			bAllPassed = false;
			continue;
		}

		// Return-property class.
		FProperty* Ret = Fn->GetReturnProperty();
		if (Entry.ExpectedReturnClass == nullptr)
		{
			// `void`-returning method (Close): there should be no
			// CPF_ReturnParm property.
			if (Ret != nullptr)
			{
				AddError(FString::Printf(
					TEXT("%s expected void return but found %s"), *EntryLabel, *Ret->GetClass()->GetName()));
				bAllPassed = false;
			}
		}
		else
		{
			if (!TestNotNull(*FString::Printf(TEXT("%s return property"), *EntryLabel), Ret))
			{
				bAllPassed = false;
				continue;
			}
			if (Ret->GetClass() != Entry.ExpectedReturnClass)
			{
				AddError(FString::Printf(TEXT("%s return type: expected %s, got %s"), *EntryLabel,
					*Entry.ExpectedReturnClass->GetName(), *Ret->GetClass()->GetName()));
				bAllPassed = false;
			}
		}

		// Parameter count.
		const int32 ActualParamCount = CountNonReturnParams(Fn);
		if (ActualParamCount != Entry.ExpectedParamClasses.Num())
		{
			AddError(FString::Printf(TEXT("%s parameter count: expected %d, got %d"), *EntryLabel,
				Entry.ExpectedParamClasses.Num(), ActualParamCount));
			bAllPassed = false;
			continue;
		}

		// Parameter property classes.
		for (int32 I = 0; I < Entry.ExpectedParamClasses.Num(); ++I)
		{
			FProperty* Param = NthNonReturnParam(Fn, I);
			if (!TestNotNull(
					*FString::Printf(TEXT("%s param %d"), *EntryLabel, I), Param))
			{
				bAllPassed = false;
				continue;
			}
			if (Param->GetClass() != Entry.ExpectedParamClasses[I])
			{
				AddError(FString::Printf(TEXT("%s param %d type: expected %s, got %s"),
					*EntryLabel, I, *Entry.ExpectedParamClasses[I]->GetName(),
					*Param->GetClass()->GetName()));
				bAllPassed = false;
			}
		}

		// FConfeatureUser struct check for the typed GetValue* family
		// (the 3rd parameter is the user object).
		if (Entry.bThirdParamIsConfeatureUser && ActualParamCount >= 3)
		{
			FProperty* UserParam = NthNonReturnParam(Fn, 2);
			FStructProperty* StructParam = CastField<FStructProperty>(UserParam);
			if (!TestNotNull(*FString::Printf(TEXT("%s user param is FStructProperty"), *EntryLabel),
					StructParam))
			{
				bAllPassed = false;
			}
			else if (StructParam->Struct != ExpectedUserStruct)
			{
				AddError(FString::Printf(
					TEXT("%s user param struct: expected FConfeatureUser, got %s"), *EntryLabel,
					StructParam->Struct ? *StructParam->Struct->GetName() : TEXT("<null>")));
				bAllPassed = false;
			}
		}

		// BlueprintCallable check — every checklist entry is exposed to
		// Blueprint per FR-019. UFUNC_BlueprintCallable is the
		// canonical bitflag on UFunction::FunctionFlags.
		if (!TestTrue(*FString::Printf(TEXT("%s is BlueprintCallable"), *EntryLabel),
				(Fn->FunctionFlags & FUNC_BlueprintCallable) != 0))
		{
			bAllPassed = false;
		}
	}

	// Hooks / events: assert each Blueprint delegate property is present,
	// is a multicast-delegate property, and is BlueprintAssignable.
	for (const FName& DelegateName : BlueprintHookDelegates)
	{
		const FString Label = DelegateName.ToString();
		FProperty* Prop = Cls->FindPropertyByName(DelegateName);
		if (!TestNotNull(*FString::Printf(TEXT("Hook delegate present: %s"), *Label), Prop))
		{
			bAllPassed = false;
			continue;
		}
		FMulticastDelegateProperty* DelegateProp = CastField<FMulticastDelegateProperty>(Prop);
		if (!TestNotNull(
				*FString::Printf(TEXT("%s is a multicast-delegate property"), *Label), DelegateProp))
		{
			bAllPassed = false;
			continue;
		}
		if (!TestTrue(*FString::Printf(TEXT("%s is BlueprintAssignable"), *Label),
				(Prop->PropertyFlags & CPF_BlueprintAssignable) != 0))
		{
			bAllPassed = false;
		}
	}

	return bAllPassed;
}
