// SPDX-License-Identifier: MIT

// ConfigCat-semantics semver parse + compare.
//
// Ported field-for-field from the spec-117 TS reference
// (packages/sdk-shared/src/semver.ts), which itself vendors ConfigCat
// common-js Semver.ts. A third-party Go semver package is NOT used —
// ConfigCat's loose-parse + precedence edge cases diverge from
// Masterminds/semver and golang.org/x/mod/semver and would fail the vendored
// testmatrix_semantic* rows.
//
// Key behaviours (verified against the TS reference):
//
//   - Strict (non-loose) parse. The FULL grammar
//     v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?, each core component a
//     0|[1-9]\d* numeric identifier; an optional leading v is allowed.
//   - Parse on trim. Callers parse value.trim(); parseSemVer also trims
//     defensively.
//   - Unparseable -> nil, never a panic. The caller treats nil as a validation
//     error (the rule errors and does not match — FR-010), NOT a silent false.
//   - Precedence: numeric major.minor.patch first; then pre-release. A version
//     WITHOUT a pre-release ranks HIGHER than one WITH a pre-release.
//     Pre-release identifiers are compared field-by-field — numeric vs numeric
//     numerically; a numeric identifier < an alphanumeric identifier;
//     alphanumeric compared ASCII-lexically; when all preceding fields are
//     equal, MORE fields rank higher than fewer.
//   - Build metadata is ignored for precedence (SemVer §10).
package evaluator

import (
	"regexp"
	"strconv"
	"strings"
)

// MAJOR.MINOR.PATCH where each core component is 0|[1-9]\d* (no leading zeros),
// an optional leading v, an optional -prerelease of dot-separated
// 0|[1-9]\d* or \d*[a-zA-Z-][a-zA-Z0-9-]* identifiers, and an optional +build of
// dot-separated [0-9A-Za-z-]+ identifiers. Mirrors the common-js FULL token.
const (
	numericIdentifier    = `0|[1-9]\d*`
	nonNumericIdentifier = `\d*[a-zA-Z-][a-zA-Z0-9-]*`
)

var (
	mainVersion         = `(` + numericIdentifier + `)\.(` + numericIdentifier + `)\.(` + numericIdentifier + `)`
	prereleaseID        = `(?:` + numericIdentifier + `|` + nonNumericIdentifier + `)`
	prereleaseGroup     = `(?:-(` + prereleaseID + `(?:\.` + prereleaseID + `)*))`
	buildIdentifier     = `[0-9A-Za-z-]+`
	buildGroup          = `(?:\+(` + buildIdentifier + `(?:\.` + buildIdentifier + `)*))`
	fullSemVerRe        = regexp.MustCompile(`^v?` + mainVersion + prereleaseGroup + `?` + buildGroup + `?$`)
	numericIdentifierRe = regexp.MustCompile(`^[0-9]+$`)
)

const (
	maxSemVerLength = 256
	// maxSafeInteger mirrors JS Number.MAX_SAFE_INTEGER (the TS reference's bound).
	maxSafeInteger = 9007199254740991
)

// semVer is a parsed semver with ConfigCat-precedence comparison.
type semVer struct {
	version string
	major   int64
	minor   int64
	patch   int64
	// prerelease holds numberified pre-release identifiers; numeric ids are
	// stored as int64, others as string. Element type is either int64 or string.
	prerelease []any
	// build holds build-metadata identifiers (ignored for precedence).
	build []string
}

// compareIdentifiers compares two pre-release / core identifiers exactly as
// common-js compareIdentifiers: both numeric -> numeric compare; a numeric
// identifier is lower-precedence than an alphanumeric one; otherwise
// ASCII-lexical. Each argument is either an int64 or a string.
func compareIdentifiers(a, b any) int {
	as := identifierString(a)
	bs := identifierString(b)
	anum := numericIdentifierRe.MatchString(as)
	bnum := numericIdentifierRe.MatchString(bs)

	if anum && bnum {
		ai, _ := strconv.ParseInt(as, 10, 64)
		bi, _ := strconv.ParseInt(bs, 10, 64)
		if ai == bi {
			return 0
		}
		if ai < bi {
			return -1
		}
		return 1
	}
	if as == bs {
		return 0
	}
	if anum && !bnum {
		return -1
	}
	if bnum && !anum {
		return 1
	}
	if as < bs {
		return -1
	}
	return 1
}

func identifierString(v any) string {
	switch x := v.(type) {
	case int64:
		return strconv.FormatInt(x, 10)
	case string:
		return x
	default:
		return ""
	}
}

func cmpInt64(a, b int64) int {
	if a == b {
		return 0
	}
	if a < b {
		return -1
	}
	return 1
}

// compare compares against other: <0 lower, 0 equal, >0 higher. Build metadata
// is ignored. Mirrors common-js SemVer.compare -> compareMain || comparePre.
func (s *semVer) compare(other *semVer) int {
	if other.version == s.version {
		return 0
	}
	if c := s.compareMain(other); c != 0 {
		return c
	}
	return s.comparePre(other)
}

func (s *semVer) compareMain(other *semVer) int {
	if c := cmpInt64(s.major, other.major); c != 0 {
		return c
	}
	if c := cmpInt64(s.minor, other.minor); c != 0 {
		return c
	}
	return cmpInt64(s.patch, other.patch)
}

func (s *semVer) comparePre(other *semVer) int {
	// A version WITHOUT a pre-release is higher-precedence than one WITH.
	if len(s.prerelease) > 0 && len(other.prerelease) == 0 {
		return -1
	}
	if len(s.prerelease) == 0 && len(other.prerelease) > 0 {
		return 1
	}
	if len(s.prerelease) == 0 && len(other.prerelease) == 0 {
		return 0
	}

	for i := 0; ; i++ {
		aHas := i < len(s.prerelease)
		bHas := i < len(other.prerelease)
		if !aHas && !bHas {
			return 0
		}
		if !bHas {
			return 1
		}
		if !aHas {
			return -1
		}
		a := s.prerelease[i]
		b := other.prerelease[i]
		if identifierString(a) == identifierString(b) && sameKind(a, b) {
			continue
		}
		return compareIdentifiers(a, b)
	}
}

// sameKind reports whether two identifiers are the same Go kind (both int64 or
// both string) — mirrors the TS `a === b` strict comparison which treats a
// numeric id and an equal-string id as distinct.
func sameKind(a, b any) bool {
	_, aInt := a.(int64)
	_, bInt := b.(int64)
	return aInt == bInt
}

// parseSemVer parses a version string under ConfigCat's strict grammar.
// Returns nil on any failure (length, grammar, out-of-range core component) —
// never panics. Trims the input first (parse on trim). The caller surfaces nil
// as a validation error (FR-010), never a silent match.
func parseSemVer(version string) *semVer {
	trimmed := strings.TrimSpace(version)
	if len(trimmed) > maxSemVerLength {
		return nil
	}
	m := fullSemVerRe.FindStringSubmatch(trimmed)
	if m == nil {
		return nil
	}

	major, err1 := strconv.ParseInt(m[1], 10, 64)
	minor, err2 := strconv.ParseInt(m[2], 10, 64)
	patch, err3 := strconv.ParseInt(m[3], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	if major > maxSafeInteger || major < 0 ||
		minor > maxSafeInteger || minor < 0 ||
		patch > maxSafeInteger || patch < 0 {
		return nil
	}

	var prerelease []any
	if m[4] != "" {
		for _, id := range strings.Split(m[4], ".") {
			if numericIdentifierRe.MatchString(id) {
				if num, err := strconv.ParseInt(id, 10, 64); err == nil && num >= 0 && num < maxSafeInteger {
					prerelease = append(prerelease, num)
					continue
				}
			}
			prerelease = append(prerelease, id)
		}
	}

	var build []string
	if m[5] != "" {
		build = strings.Split(m[5], ".")
	}

	canonical := strconv.FormatInt(major, 10) + "." + strconv.FormatInt(minor, 10) + "." + strconv.FormatInt(patch, 10)
	if len(prerelease) > 0 {
		parts := make([]string, len(prerelease))
		for i, p := range prerelease {
			parts[i] = identifierString(p)
		}
		canonical += "-" + strings.Join(parts, ".")
	}

	return &semVer{
		version:    canonical,
		major:      major,
		minor:      minor,
		patch:      patch,
		prerelease: prerelease,
		build:      build,
	}
}
