// SPDX-License-Identifier: MIT

package confeature

// User is the targeting context passed to GetValue / GetValueWithContext
// / Snapshot.GetValue. Field names mirror configcat/go-sdk v9 1:1
// (Principle II).
//
// In the v1 boolean-only evaluator User is accepted for API parity but
// not consulted — there are no targeting rules in the v1 corpus.
// Future evaluator versions read Identifier for percentage-routing and
// Email/Country/Custom for targeting predicates.
//
// A nil *User signals "no targeting context"; the evaluator treats it
// the same as a User with empty fields.
type User struct {
	// Identifier is the principal id (typically email or UUID).
	// Empty is a valid value — corresponds to the "empty-id" user
	// variant in the parity corpus.
	Identifier string

	// Email is the optional email address (used by some targeting
	// predicates in non-v1 evaluators).
	Email string

	// Country is the optional ISO country code.
	Country string

	// Custom is the optional bag of customer-defined attributes.
	//
	// Values are typed to mirror configcat/go-sdk v9's UserData.Custom
	// (map[string]interface{}, Principle II): a custom attribute value may
	// be a string, a numeric type (int/int64/float64/...), a bool, a
	// []string, or a time.Time. Non-string values are converted to
	// ConfigCat's canonical string before TEXT comparisons (number →
	// invariant decimal, time.Time → Unix epoch seconds, []string → JSON)
	// and threaded natively into number / datetime / array comparators.
	Custom map[string]any
}
