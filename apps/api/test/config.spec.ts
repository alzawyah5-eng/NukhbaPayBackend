import assert from "node:assert/strict";
import test from "node:test";
import { parseApiConfig } from "../src/api.config.js";
import { bootstrap } from "../src/main.js";

test("API configuration defaults to IPv4 loopback and a valid local port", () => {
  assert.deepEqual(parseApiConfig({}), { host: "127.0.0.1", port: 3000 });
  assert.deepEqual(parseApiConfig({ API_HOST: "::1", API_PORT: "4312" }), {
    host: "::1",
    port: 4312,
  });
});

test("invalid listener hosts and ports are rejected before startup", async () => {
  for (const host of ["", "localhost", "0.0.0.0/0"]) {
    assert.throws(() => parseApiConfig({ API_HOST: host }), TypeError);
  }

  for (const port of ["", "0", "03000", "-1", "65536", "3000.5", " 3000"]) {
    assert.throws(() => parseApiConfig({ API_PORT: port }), /API_PORT/);
  }

  await assert.rejects(bootstrap({ API_HOST: "localhost" }), /API_HOST must be an IPv4 or IPv6 address literal/);
});
