# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Semver do
  @moduledoc """
  ConfigCat-semantics semver parse + compare (spec 124, FR-003).

  Ported field-for-field from `packages/sdk-shared/src/semver.ts` (which
  itself vendors ConfigCat `common-js` `Semver.ts`). We do NOT use Elixir's
  `Version` module or a Hex semver — their loose-parse and precedence edge
  cases diverge from ConfigCat and would fail `testmatrix_semantic*`.

  Key behaviours:

    * Strict (non-loose) `FULL` grammar: `v?MAJOR.MINOR.PATCH(-pre)?(+build)?`,
      each core component `0|[1-9]\\d*` (no leading zeros). Optional leading `v`.
    * Parse on trim. Unparseable → `nil`, never a raise; the caller surfaces
      `nil` as a validation error.
    * Precedence: numeric major.minor.patch first; then pre-release. A version
      WITHOUT a pre-release ranks HIGHER than one WITH. Pre-release identifiers
      compared field-by-field — numeric < alphanumeric; numeric vs numeric
      numerically; alphanumeric ASCII-lexically; more fields rank higher when
      all preceding are equal.
    * Build metadata is ignored for precedence.
  """

  @max_length 256
  # JS Number.MAX_SAFE_INTEGER — the upstream out-of-range guard.
  @max_safe_integer 9_007_199_254_740_991

  @numeric_identifier "0|[1-9]\\d*"
  @non_numeric_identifier "\\d*[a-zA-Z-][a-zA-Z0-9-]*"

  defstruct [:version, :major, :minor, :patch, :prerelease, :build]

  @type ident :: integer() | String.t()
  @type t :: %__MODULE__{
          version: String.t(),
          major: integer(),
          minor: integer(),
          patch: integer(),
          prerelease: [ident()],
          build: [String.t()]
        }

  main = "(#{@numeric_identifier})\\.(#{@numeric_identifier})\\.(#{@numeric_identifier})"
  prerelease_id = "(?:#{@numeric_identifier}|#{@non_numeric_identifier})"
  prerelease = "(?:-(#{prerelease_id}(?:\\.#{prerelease_id})*))"
  build_id = "[0-9A-Za-z-]+"
  build = "(?:\\+(#{build_id}(?:\\.#{build_id})*))"

  @full Regex.compile!("^v?#{main}#{prerelease}?#{build}?$")
  @numeric_re ~r/^[0-9]+$/

  @doc """
  Parse a version string under ConfigCat's strict grammar, returning `nil`
  on any failure (length, grammar, out-of-range core) — never raising.
  """
  @spec parse(String.t()) :: t() | nil
  def parse(version) when is_binary(version) do
    trimmed = String.trim(version)

    cond do
      String.length(trimmed) > @max_length ->
        nil

      true ->
        case Regex.run(@full, trimmed, capture: :all_but_first) do
          nil -> nil
          captures -> build_from_captures(captures)
        end
    end
  end

  def parse(_), do: nil

  defp build_from_captures([major_s, minor_s, patch_s | rest]) do
    major = String.to_integer(major_s)
    minor = String.to_integer(minor_s)
    patch = String.to_integer(patch_s)

    if in_range?(major) and in_range?(minor) and in_range?(patch) do
      pre_s = Enum.at(rest, 0)
      build_s = Enum.at(rest, 1)

      prerelease = parse_prerelease(pre_s)
      build = parse_build(build_s)

      canonical =
        if prerelease == [] do
          "#{major}.#{minor}.#{patch}"
        else
          "#{major}.#{minor}.#{patch}-#{Enum.map_join(prerelease, ".", &to_string/1)}"
        end

      %__MODULE__{
        version: canonical,
        major: major,
        minor: minor,
        patch: patch,
        prerelease: prerelease,
        build: build
      }
    else
      nil
    end
  end

  defp in_range?(n), do: n >= 0 and n <= @max_safe_integer

  defp parse_prerelease(nil), do: []
  defp parse_prerelease(""), do: []

  defp parse_prerelease(s) do
    s
    |> String.split(".")
    |> Enum.map(fn id ->
      if Regex.match?(@numeric_re, id) do
        num = String.to_integer(id)
        if num >= 0 and num < @max_safe_integer, do: num, else: id
      else
        id
      end
    end)
  end

  defp parse_build(nil), do: []
  defp parse_build(""), do: []
  defp parse_build(s), do: String.split(s, ".")

  @doc """
  Compare two versions: `<0` if `a` is lower-precedence, `0` if equal, `>0`
  if higher. Build metadata is ignored. Mirrors `SemVer.compare`.
  """
  @spec compare(t(), t()) :: integer()
  def compare(%__MODULE__{version: v} = a, %__MODULE__{version: v2} = b) do
    if v == v2 do
      0
    else
      case compare_main(a, b) do
        0 -> compare_pre(a, b)
        c -> c
      end
    end
  end

  defp compare_main(a, b) do
    case compare_identifiers(a.major, b.major) do
      0 ->
        case compare_identifiers(a.minor, b.minor) do
          0 -> compare_identifiers(a.patch, b.patch)
          c -> c
        end

      c ->
        c
    end
  end

  defp compare_pre(a, b) do
    cond do
      a.prerelease != [] and b.prerelease == [] -> -1
      a.prerelease == [] and b.prerelease != [] -> 1
      a.prerelease == [] and b.prerelease == [] -> 0
      true -> compare_pre_lists(a.prerelease, b.prerelease)
    end
  end

  defp compare_pre_lists([], []), do: 0
  defp compare_pre_lists([_ | _], []), do: 1
  defp compare_pre_lists([], [_ | _]), do: -1

  defp compare_pre_lists([a | ta], [b | tb]) do
    if a == b do
      compare_pre_lists(ta, tb)
    else
      compare_identifiers(a, b)
    end
  end

  # Mirrors common-js `compareIdentifiers`: both numeric → numeric compare; a
  # numeric identifier is lower-precedence than an alphanumeric one; otherwise
  # ASCII-lexical.
  defp compare_identifiers(a, b) do
    anum = numeric?(a)
    bnum = numeric?(b)

    {av, bv} =
      if anum and bnum, do: {to_int(a), to_int(b)}, else: {a, b}

    cond do
      av == bv -> 0
      anum and not bnum -> -1
      bnum and not anum -> 1
      av < bv -> -1
      true -> 1
    end
  end

  defp numeric?(v) when is_integer(v), do: true
  defp numeric?(v) when is_binary(v), do: Regex.match?(@numeric_re, v)

  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_binary(v), do: String.to_integer(v)
end
