// SPDX-License-Identifier: MIT

// Segment-condition constants (v6 + legacy v5).
//
// Ported from the spec-117 TS reference (packages/sdk-shared/src/segments.ts),
// itself from common-js RolloutEvaluator.evaluateSegmentCondition.
//
// A segment condition ({"s": index, "c": comparator}) references a segment by
// index into the config's top-level s[] ({"n": name, "r": [...]}) and a
// SegmentComparator (IsIn / IsNotIn). The segment's r[] entries are bare user
// conditions (each an IUserCondition), AND-grouped: the user IS-IN the segment
// iff every condition matches. The decision is then optionally negated by
// IsNotIn.
//
// The sensitive-comparator context salt is the segment NAME (segment["n"]), NOT
// the setting key — the crucial divergence from a user condition.
//
// The resolution itself lives in evaluator.go::evaluateSegmentCond (it owns the
// shared evaluateConditions machinery + the eval-log trace block); this file
// carries the shared comparator constants + the malformed-reference sentinel.
package evaluator

import "errors"

const (
	segmentIsIn    = 0
	segmentIsNotIn = 1
)

// errSegmentReference is a malformed segment reference / name — a fatal config
// error (fail-closed).
var errSegmentReference = errors.New("segment reference is invalid")
