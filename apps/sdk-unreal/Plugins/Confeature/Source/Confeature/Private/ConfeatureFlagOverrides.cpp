// SPDX-License-Identifier: MIT

// Out-of-line member for the full-config override source (spec 135 / #441,
// epic #382, US3). Derives the flat base-value envelopes from the config's
// `f` object — the UE mirror of the C++ #437
// `ConfigOverrideDataSource::baseValuesOf`
// (apps/sdk-cpp/include/confeature/flag_overrides.h): first non-null of the
// `v.{b,s,i,d}` slots, used only for key enumeration. Rule resolution never
// goes through this map.

#include "ConfeatureFlagOverrides.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

TMap<FString, TSharedPtr<FJsonValue>> FConfeatureConfigOverrideDataSource::BaseValuesOf(
	const TSharedPtr<FJsonObject>& Config)
{
	TMap<FString, TSharedPtr<FJsonValue>> Out;
	if (!Config.IsValid())
	{
		return Out;
	}

	const TSharedPtr<FJsonObject>* SettingsObj = nullptr;
	if (!Config->TryGetObjectField(TEXT("f"), SettingsObj) || SettingsObj == nullptr
		|| !SettingsObj->IsValid())
	{
		return Out;
	}

	for (const auto& Pair : (*SettingsObj)->Values)
	{
		const TSharedPtr<FJsonValue>& SettingVal = Pair.Value;
		if (!SettingVal.IsValid() || SettingVal->Type != EJson::Object)
		{
			continue;
		}
		const TSharedPtr<FJsonObject>& Setting = SettingVal->AsObject();
		if (!Setting.IsValid())
		{
			continue;
		}
		const TSharedPtr<FJsonObject>* ValueObj = nullptr;
		if (!Setting->TryGetObjectField(TEXT("v"), ValueObj) || ValueObj == nullptr
			|| !ValueObj->IsValid())
		{
			continue;
		}
		// First non-null of b / s / i / d, matching the C++ slot order.
		static const TCHAR* const Slots[] = {TEXT("b"), TEXT("s"), TEXT("i"), TEXT("d")};
		for (const TCHAR* Slot : Slots)
		{
			const TSharedPtr<FJsonValue> SlotVal = (*ValueObj)->TryGetField(Slot);
			if (SlotVal.IsValid() && SlotVal->Type != EJson::Null)
			{
				Out.Add(Pair.Key, SlotVal);
				break;
			}
		}
	}
	return Out;
}
