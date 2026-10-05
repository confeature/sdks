# SPDX-License-Identifier: MIT

%{
  configs: [
    %{
      name: "default",
      files: %{
        included: ["lib/", "test/"],
        excluded: ["_build/", "deps/"]
      },
      strict: true,
      checks: [
        # Disable docs-required checks since SPDX headers + module docs cover
        # the same ground; the public Confeature.* modules carry @moduledoc.
        {Credo.Check.Readability.ModuleDoc, false},
        # Allow function-level @docs to be omitted on tiny internal helpers.
        {Credo.Check.Readability.Specs, false},
        # Allow @spec to be omitted — typespecs not yet mandated by spec 052.
        #
        # Principle-II relaxations (#420): the `Confeature.Internal.*` evaluator
        # is a faithful 1:1 port of the JS reference engine. Its control flow
        # intentionally MIRRORS the reference (a flat 36-arm comparator dispatch,
        # guard-style single-branch `cond`s, the same branch order) so the port
        # stays auditably equivalent against upstream. Refactoring it to
        # Elixir-idiomatic forms would diverge from the byte-verified reference
        # and obscure the parity mapping, so the following structural checks are
        # relaxed for this ported engine rather than rewritten:
        #   * CyclomaticComplexity: the comparator dispatch is inherently a wide
        #     switch (29); bumped to 30 (still catches genuine runaway growth).
        #   * CondStatements / NegatedConditionsWithElse / AliasUsage: mirror the
        #     reference's structure verbatim.
        #   * LargeNumbers: the conversion test carries ported corpus float
        #     literals (e.g. -1.23456789e96) that must stay byte-identical to the
        #     federated corpus values.
        {Credo.Check.Refactor.CyclomaticComplexity, max_complexity: 30},
        {Credo.Check.Refactor.CondStatements, false},
        {Credo.Check.Refactor.NegatedConditionsWithElse, false},
        {Credo.Check.Design.AliasUsage, false},
        {Credo.Check.Readability.LargeNumbers, false},
        {Credo.Check.Refactor.LongQuoteBlocks, false},
        {Credo.Check.Refactor.Nesting, max_nesting: 4}
      ]
    }
  ]
}
