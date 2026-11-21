// SPDX-License-Identifier: MIT

use open_feature::{EvaluationContext, EvaluationContextFieldValue as Field};

use crate::{user::UserValue, User};

pub(super) fn user_from_context(context: &EvaluationContext) -> Option<User> {
    let mut user = User::new(context.targeting_key.as_deref().unwrap_or_default());
    for (key, field) in &context.custom_fields {
        match key.as_str() {
            // Custom fields must never shadow the SDK identity used for targeting.
            "targetingKey" | "Identifier" => {}
            "Email" => user.email = field.as_str().map(str::to_owned),
            "Country" => user.country = field.as_str().map(str::to_owned),
            _ => {
                if let Some(value) = custom_value(field) {
                    user.custom.insert(key.clone(), value);
                }
            }
        }
    }
    // Preserve the SDK's anonymous evaluation if there was no usable context.
    (context.targeting_key.is_some()
        || user.email.is_some()
        || user.country.is_some()
        || !user.custom.is_empty())
    .then_some(user)
}

fn custom_value(field: &Field) -> Option<UserValue> {
    match field {
        Field::Bool(value) => Some((*value).into()),
        Field::Int(value) => Some(UserValue::Int(*value)),
        Field::Float(value) if value.is_finite() => Some(UserValue::Float(*value)),
        Field::Float(_) => None,
        Field::String(value) => Some(UserValue::String(value.clone())),
        Field::DateTime(value) => Some(UserValue::DateTime(
            value.unix_timestamp_nanos() as f64 / 1_000_000_000.0,
        )),
        Field::Struct(value) => value
            .downcast_ref::<Vec<String>>()
            .cloned()
            .map(UserValue::StringVec),
    }
}
