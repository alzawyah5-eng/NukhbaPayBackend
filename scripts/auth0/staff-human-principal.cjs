"use strict";

// Copy this whole file into a development Post Login Action. Not wired to the BFF.
exports.onExecutePostLogin = async (event, api) => {
  const secrets = event?.secrets;
  const clientId = secrets?.NUKHBAPAY_STAFF_PORTAL_CLIENT_ID;
  const connectionId = secrets?.NUKHBAPAY_STAFF_DATABASE_CONNECTION_ID;
  const audience = secrets?.NUKHBAPAY_STAFF_API_AUDIENCE;
  const text = (value, max) => typeof value === "string" && value.length > 0 &&
    value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);

  // Without a valid target client, omit the claim; never guess a tenant-wide target.
  if (!text(clientId, 128) || event?.client?.client_id !== clientId) return;
  const deny = () => api.access.deny("Staff principal classification denied");
  if (!text(connectionId, 128) || !text(audience, 512)) return deny();
  try {
    const url = new URL(audience);
    if (!["https:", "urn:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return deny();
  } catch { return deny(); }

  const transaction = event.transaction;
  const subject = event.user?.user_id;
  if (event.connection?.id !== connectionId || event.connection?.strategy !== "auth0" ||
      !text(subject, 512) || !subject.startsWith("auth0|") || subject.length === 6 || subject.endsWith("@clients") ||
      transaction?.protocol !== "oidc-basic-profile" ||
      !Array.isArray(transaction.response_type) || transaction.response_type.length !== 1 || transaction.response_type[0] !== "code" ||
      transaction.response_mode !== "query" || transaction.redirect_uri !== "https://localhost:3001/auth/callback" ||
      !Array.isArray(transaction.requested_scopes) || transaction.requested_scopes.length !== 1 || transaction.requested_scopes[0] !== "openid" ||
      event.resource_server?.identifier !== audience ||
      event.agent !== undefined || event.session?.actor !== undefined ||
      ["actor", "actor_token_type", "subject_token_type", "linking_id"].some(key => transaction[key] !== undefined)) return deny();

  // Trust anchor: the approved database connection admits only operator-provisioned humans.
  // This classification is neither staff enrollment nor MFA/role/permission evidence.
  api.accessToken.setCustomClaim("https://claims.nukhbapay.com/principal", "human");
};
