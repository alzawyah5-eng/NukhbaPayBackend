"use strict";

// Development probe. Use the same source on both sides of the existing MFA Action.
const { createHash } = require("node:crypto");
const metadataKey = "nukhbapay_staff_mfa_observation_v1";
const factors = new Set(["otp", "webauthn-platform", "webauthn-roaming"]);
const opaque = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const bounded = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const opaqueDigest = value => typeof value === "string" && opaque.test(value) ? digest(value) : null;

function completedFactors(methods) {
  if (!Array.isArray(methods) || methods.length > 64) return null;
  return methods.filter(method => method?.name === "mfa").map(method => {
    const timestamp = bounded(method.timestamp) ? Date.parse(method.timestamp) : NaN;
    const exactTime = Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString() === method.timestamp;
    return {
      key: digest(JSON.stringify([bounded(method.type) ? method.type : null,
        bounded(method.timestamp) ? method.timestamp : null])),
      timestamp,
      approved: exactTime && factors.has(method.type)
    };
  });
}

exports.onExecutePostLogin = async (event, api) => {
  const stage = event?.secrets?.NUKHBAPAY_MFA_PROBE_STAGE;
  const client = event?.secrets?.NUKHBAPAY_STAFF_CLIENT_ID;
  const subject = event?.secrets?.NUKHBAPAY_MFA_PROBE_SUBJECT;
  const transaction = event?.transaction;
  if ((stage !== "before" && stage !== "after") || !bounded(client) || !bounded(subject) ||
      event?.client?.client_id !== client || event?.user?.user_id !== subject ||
      transaction?.protocol !== "oidc-basic-profile" ||
      transaction.redirect_uri !== "https://localhost:3001/auth/callback") return;

  try {
    const tx = bounded(transaction.id) ? digest(transaction.id) : null;
    const state = opaqueDigest(transaction.state);
    const nonce = opaqueDigest(event.request?.query?.nonce);
    const methods = completedFactors(event.authentication?.methods);
    if (stage === "before") {
      const enrolled = event.user.enrolledFactors;
      if (!Array.isArray(enrolled) || !enrolled.some(factor => factors.has(factor?.type))) return;
      api.transaction.setMetadata(metadataKey, JSON.stringify({
        tx, state, nonce, started: Date.now(), baseline: methods?.map(method => method.key) ?? null
      }));
      return;
    }

    const raw = transaction.metadata?.[metadataKey];
    const before = typeof raw === "string" && raw.length <= 4800 ? JSON.parse(raw) : null;
    const matched = Boolean(tx && before?.tx === tx);
    // Compare occurrences as well as values so repeated identical entries stay detectable.
    const remaining = Array.isArray(before?.baseline) ? [...before.baseline] : null;
    const added = remaining === null || methods === null ? [] : methods.filter(method => {
      const index = remaining.indexOf(method.key);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
    const fresh = matched && remaining?.length === 0 && added.length === 1 &&
      added[0].approved && !before.baseline.includes(added[0].key) &&
      Number.isSafeInteger(before.started) && added[0].timestamp >= before.started && added[0].timestamp <= Date.now();
    console.log("NUKHBAPAY_MFA_OBSERVATION " + JSON.stringify({
      sameTransaction: matched,
      sameState: Boolean(matched && state && before.state === state),
      nonceBefore: Boolean(matched && before.nonce),
      sameNonce: Boolean(matched && nonce && before.nonce === nonce),
      freshFactor: Boolean(fresh)
    }));
  } catch {
    // A diagnostic failure must leave the existing MFA policy in control.
    console.log("NUKHBAPAY_MFA_OBSERVATION_UNAVAILABLE");
  }
};
