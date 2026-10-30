// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_USER_H_
#define CONFEATURE_USER_H_

// `User` mirrors ConfigCat-cpp's targeting user object. It surfaces the
// well-known attributes (identifier, email, country) plus custom
// attributes. Custom attributes are TYPED, matching configcat-cpp's
// `ConfigCatUser::AttributeValue` 1:1 (Principle II):
//
//   using AttributeValue =
//       std::variant<std::string, double, date_time_t, std::vector<std::string>>;
//   using date_time_t = std::chrono::system_clock::time_point;
//
// (Numbers are `double` — there is deliberately no integer variant, just
// as in configcat-cpp.) A non-string attribute is canonicalised to its
// ConfigCat-exact text form by the evaluator at comparison time
// (`userAttributeValueToString`): number → ECMAScript `Number.toString`,
// date_time_t → Unix **seconds**, string array → compact `JSON.stringify`.
// A string attribute is used verbatim.

#include <chrono>
#include <map>
#include <string>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace confeature {

class User {
 public:
  // Mirrors `configcat::ConfigCatUser`'s public alias surface 1:1.
  using date_time_t = std::chrono::system_clock::time_point;
  using AttributeValue = std::variant<std::string, double, date_time_t, std::vector<std::string>>;

  explicit User(std::string identifier) : identifier_(std::move(identifier)) {}

  const std::string& identifier() const { return identifier_; }

  User& withEmail(std::string email) {
    email_ = std::move(email);
    return *this;
  }
  User& withCountry(std::string country) {
    country_ = std::move(country);
    return *this;
  }

  // ── custom attributes ─────────────────────────────────────────────────────
  // The legacy string overload (kept for source compatibility with the v0.1
  // surface) and the typed overloads (configcat-cpp parity). Every overload
  // routes into the typed `customAttributes_` store; the string overload also
  // keeps the legacy `custom_` string map populated so `custom()` keeps
  // returning string-typed entries unchanged (no regression).
  User& withCustom(std::string key, std::string value) {
    custom_.insert_or_assign(key, value);
    customAttributes_.insert_or_assign(std::move(key), AttributeValue{std::move(value)});
    return *this;
  }
  User& withCustom(std::string key, double value) {
    customAttributes_.insert_or_assign(std::move(key), AttributeValue{value});
    return *this;
  }
  User& withCustom(std::string key, date_time_t value) {
    customAttributes_.insert_or_assign(std::move(key), AttributeValue{value});
    return *this;
  }
  User& withCustom(std::string key, std::vector<std::string> value) {
    customAttributes_.insert_or_assign(std::move(key), AttributeValue{std::move(value)});
    return *this;
  }
  // Generic typed overload (configcat-cpp accepts an `AttributeValue`).
  User& withCustom(std::string key, AttributeValue value) {
    if (std::holds_alternative<std::string>(value)) {
      custom_.insert_or_assign(key, std::get<std::string>(value));
    }
    customAttributes_.insert_or_assign(std::move(key), std::move(value));
    return *this;
  }

  const std::string& email() const { return email_; }
  const std::string& country() const { return country_; }

  // Legacy string-only view (well-known v0.1 accessor). Holds only the
  // attributes set via the string `withCustom` overload.
  const std::map<std::string, std::string>& custom() const { return custom_; }

  // Typed view — the evaluator reads this so it can canonicalise non-string
  // attributes ConfigCat-exactly.
  const std::unordered_map<std::string, AttributeValue>& customAttributes() const {
    return customAttributes_;
  }

 private:
  std::string identifier_;
  std::string email_;
  std::string country_;
  std::map<std::string, std::string> custom_;
  std::unordered_map<std::string, AttributeValue> customAttributes_;
};

}  // namespace confeature

#endif  // CONFEATURE_USER_H_
