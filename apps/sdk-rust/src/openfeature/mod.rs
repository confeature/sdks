// SPDX-License-Identifier: MIT

//! OpenFeature integration for an application-owned Confeature client.

use async_trait::async_trait;
use open_feature::provider::{FeatureProvider, ProviderMetadata, ResolutionDetails};
use open_feature::{
    EvaluationContext, EvaluationError, EvaluationErrorCode, EvaluationReason, EvaluationResult,
    StructValue,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::Client;

mod context;
use context::user_from_context;

#[cfg(test)]
mod tests;

/// Resolves OpenFeature flags through a shared Confeature client.
///
/// The application manages the client's polling and lifetime. Registration
/// is immediate, and evaluation follows the client's native polling mode.
pub struct ConfeatureProvider {
    client: Arc<Client>,
    metadata: ProviderMetadata,
}

impl ConfeatureProvider {
    /// Creates a provider for an existing client.
    ///
    /// A configured SDK default user would make anonymous OpenFeature
    /// evaluations reuse another identity, so such a client is rejected.
    pub fn new(client: Arc<Client>) -> EvaluationResult<Self> {
        if client.has_default_user() {
            return Err(evaluation_error(
                EvaluationErrorCode::General("GENERAL".into()),
                "Confeature provider requires an SDK client without a default user",
            ));
        }
        Ok(Self {
            client,
            metadata: ProviderMetadata::new("Confeature"),
        })
    }

    async fn resolve<T: DeserializeOwned>(
        &self,
        key: &str,
        default: Value,
        context: &EvaluationContext,
    ) -> EvaluationResult<ResolutionDetails<T>> {
        let user = user_from_context(context);
        let details = self
            .client
            .get_value_details_strict(key, default, user.as_ref())
            .await;
        if details.is_default_value {
            return Err(sdk_error(details.error.as_deref()));
        }

        let value: T =
            serde_json::from_value(details.value).map_err(|_| sdk_error(Some("TYPE_MISMATCH")))?;
        let mut resolution = ResolutionDetails::new(value);
        resolution.variant = details.variation_id;
        // A matched rule can itself serve a percentage option. In that
        // case the split selected the final value.
        resolution.reason = if details.matched_percentage_option.is_some() {
            Some(EvaluationReason::Split)
        } else if details.matched_targeting_rule.is_some() {
            Some(EvaluationReason::TargetingMatch)
        } else {
            None
        };
        Ok(resolution)
    }
}

#[async_trait]
impl FeatureProvider for ConfeatureProvider {
    fn metadata(&self) -> &ProviderMetadata {
        &self.metadata
    }

    async fn resolve_bool_value(
        &self,
        flag_key: &str,
        evaluation_context: &EvaluationContext,
    ) -> EvaluationResult<ResolutionDetails<bool>> {
        self.resolve(flag_key, Value::Bool(false), evaluation_context)
            .await
    }

    async fn resolve_int_value(
        &self,
        flag_key: &str,
        evaluation_context: &EvaluationContext,
    ) -> EvaluationResult<ResolutionDetails<i64>> {
        self.resolve(flag_key, json!(0_i64), evaluation_context)
            .await
    }

    async fn resolve_float_value(
        &self,
        flag_key: &str,
        evaluation_context: &EvaluationContext,
    ) -> EvaluationResult<ResolutionDetails<f64>> {
        self.resolve(flag_key, json!(0.0_f64), evaluation_context)
            .await
    }

    async fn resolve_string_value(
        &self,
        flag_key: &str,
        evaluation_context: &EvaluationContext,
    ) -> EvaluationResult<ResolutionDetails<String>> {
        self.resolve(flag_key, Value::String(String::new()), evaluation_context)
            .await
    }

    async fn resolve_struct_value(
        &self,
        _flag_key: &str,
        _evaluation_context: &EvaluationContext,
    ) -> EvaluationResult<ResolutionDetails<StructValue>> {
        Err(sdk_error(Some("TYPE_MISMATCH")))
    }
}

fn sdk_error(code: Option<&str>) -> EvaluationError {
    use EvaluationErrorCode::{FlagNotFound, General, ParseError, ProviderNotReady, TypeMismatch};

    // The SDK exposes fixed codes in EvaluationDetails.error. Use those
    // codes to choose a constant message for OpenFeature.
    let (code, message) = match code {
        Some("NO_CONFIG" | "CLIENT_CLOSED") => {
            (ProviderNotReady, "Confeature configuration is unavailable")
        }
        Some("KEY_NOT_FOUND") => (FlagNotFound, "Confeature flag was not found"),
        Some("TYPE_MISMATCH" | "UNSUPPORTED_TYPE") => (
            TypeMismatch,
            "Confeature flag value has an incompatible type",
        ),
        Some("MALFORMED_CONFIG" | "MALFORMED_VALUE" | "VALUE_NOT_BOOL") => {
            (ParseError, "Confeature flag configuration is malformed")
        }
        _ => (
            General("GENERAL".into()),
            "Confeature flag evaluation failed",
        ),
    };
    evaluation_error(code, message)
}

fn evaluation_error(code: EvaluationErrorCode, message: &str) -> EvaluationError {
    EvaluationError {
        code,
        message: Some(message.to_owned()),
    }
}
