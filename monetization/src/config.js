"use strict";

function billingConfigFromEnv(env = process.env) {
  const billingEnabled = env.FORESIGHT_CLERK_BILLING_ENABLED === "true";
  const publishableKeyIsTest = /^pk_test_/.test(env.CLERK_PUBLISHABLE_KEY || "");
  const secretKeyIsTest = /^sk_test_/.test(env.CLERK_SECRET_KEY || "");
  const webhookVerificationConfigured = /^whsec_/.test(env.CLERK_WEBHOOK_SIGNING_SECRET || "");
  const ready = billingEnabled && publishableKeyIsTest && secretKeyIsTest && webhookVerificationConfigured;
  const missing = [];
  if (!billingEnabled) missing.push("billing_not_explicitly_enabled");
  if (!publishableKeyIsTest) missing.push("missing_pk_test_publishable_key");
  if (!secretKeyIsTest) missing.push("missing_sk_test_secret_key");
  if (!webhookVerificationConfigured) missing.push("missing_webhook_signing_secret");
  return Object.freeze({
    billingEnabled,
    developmentKeys: publishableKeyIsTest && secretKeyIsTest,
    webhookVerificationConfigured,
    ready,
    canRenderCheckout: false,
    missing: Object.freeze(missing),
  });
}

module.exports = { billingConfigFromEnv };
