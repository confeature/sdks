// SPDX-License-Identifier: MIT

package evaluator

// User is the evaluator-internal targeting context. The public confeature.User
// (string-only custom map) is adapted into this richer shape at the entry, so
// the corpus's typed-attribute conversion cases can be exercised faithfully
// while the public SDK surface stays unchanged.
type User struct {
	Identifier string
	// MissingIdentifier preserves the absence of a targeting key for provider calls.
	MissingIdentifier bool
	Email             string
	Country           string
	// Custom carries ConfigCat's UserAttributeValue family (string / number /
	// bool / []string). The matrices feed strings; the conversion driver feeds
	// typed values.
	Custom map[string]any
}

const (
	identifierAttribute = "Identifier"
	emailAttribute      = "Email"
	countryAttribute    = "Country"
)

// getUserAttribute reads a well-known or custom attribute. Mirrors
// user.ts::getUserAttribute: Identifier → identifier ?? ""; Email → email;
// Country → country; else custom[name]. Returns (value, present).
func getUserAttribute(user *User, name string) (any, bool) {
	switch name {
	case identifierAttribute:
		return user.Identifier, !user.MissingIdentifier
	case emailAttribute:
		if user.Email == "" {
			return nil, false
		}
		return user.Email, true
	case countryAttribute:
		if user.Country == "" {
			return nil, false
		}
		return user.Country, true
	default:
		if user.Custom != nil {
			if v, ok := user.Custom[name]; ok {
				return v, true
			}
		}
		return nil, false
	}
}
