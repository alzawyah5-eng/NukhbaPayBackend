import assert from "node:assert/strict";
import test from "node:test";
import { MAX_AUTHORIZATION_HEADER_BYTES, parseBearerAuthorizationHeader, readBearerAuthorization } from "../src/modules/identity/authorization-header.js";

test("bearer parsing is bounded and raw headers preserve duplicate detection", () => {
  assert.equal(parseBearerAuthorizationHeader("bEaReR a.b.c"), "a.b.c");
  assert.equal(readBearerAuthorization(["Host", "synthetic.invalid", "Authorization", "Bearer a.b.c"]), "a.b.c");
  assert.throws(() => parseBearerAuthorizationHeader(undefined), { code: "MISSING_CREDENTIALS" });
  assert.throws(() => readBearerAuthorization(["Host", "synthetic.invalid"]), { code: "MISSING_CREDENTIALS" });
  for (const value of ["", "Bearer", "Basic a.b.c", "Bearer  a.b.c", "Bearer\ta.b.c", "Bearer a.b.c ",
    "Bearer a.b.c,d.e.f", "Bearer a.b.c\r\n", "Bearer a.b.c\n", "Bearer opaque", "Bearer a.b.", "Bearer a.b.c.d.e",
    "Bearer é.b.c", "Bearer " + "a".repeat(MAX_AUTHORIZATION_HEADER_BYTES), ["Bearer a.b.c"]]) {
    assert.throws(() => parseBearerAuthorizationHeader(value), { code: "INVALID_TOKEN" });
  }
  for (const headers of [
    ["Authorization", "Bearer a.b.c", "authorization", "Bearer d.e.f"],
    ["Authorization"], Array<string>(202).fill("x"),
  ]) assert.throws(() => readBearerAuthorization(headers), { code: "INVALID_TOKEN" });
});
