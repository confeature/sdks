// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using Confeature.Client.Internal;
using OpenFeature.Model;

namespace Confeature.OpenFeature;

internal sealed class OpenFeatureUser(EvaluationContext context) : IEvalUser
{
    private const string TargetingKeyField = "targetingKey";
    private const string SdkIdentifierField = "Identifier";

    public string Identifier => context.TargetingKey ?? string.Empty;

    public object? GetAttribute(string name)
    {
        if (name == SdkIdentifierField)
        {
            // A missing key stays absent for the evaluator's percentage attribute lookup.
            return context.TargetingKey;
        }

        if (name == TargetingKeyField || !context.TryGetValue(name, out var value))
        {
            return null;
        }

        var attribute = value?.AsObject;
        return attribute switch
        {
            string or bool or double or DateTime => attribute,
            IReadOnlyList<Value> list => ReadStrings(list),
            _ => null,
        };
    }

    public IEnumerable<string> CustomKeysInOrder()
    {
        var keys = new List<string>();
        foreach (var attribute in context)
        {
            if (attribute.Key is not (TargetingKeyField or SdkIdentifierField or "Email" or "Country"))
            {
                keys.Add(attribute.Key);
            }
        }

        keys.Sort(StringComparer.Ordinal);
        return keys;
    }

    private static string[]? ReadStrings(IReadOnlyList<Value> list)
    {
        var strings = new string[list.Count];
        for (var index = 0; index < list.Count; index++)
        {
            if (list[index]?.AsString is not { } value)
            {
                return null;
            }

            strings[index] = value;
        }

        return strings;
    }
}
