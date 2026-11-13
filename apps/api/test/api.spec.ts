import assert from "node:assert/strict";
import test from "node:test";
import { createApiApplication, MAX_REQUEST_BODY_BYTES } from "../src/http-application.js";

test("the API starts and serves a local process-liveness response with bounded safe errors", async () => {
  const app = await createApiApplication();

  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    const liveResponse = await fetch(`${origin}/health/live`);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), { status: "ok" });
    assert.equal(liveResponse.headers.get("cache-control"), "no-store");

    const notFoundResponse = await fetch(`${origin}/internal-test-path`);
    assert.equal(notFoundResponse.status, 404);
    const notFoundBody = await notFoundResponse.json() as { statusCode: number; message: string };
    assert.deepEqual(notFoundBody, {
      statusCode: 404,
      message: "Request could not be completed",
    });
    assert.equal(JSON.stringify(notFoundBody).includes("internal-test-path"), false);

    const invalidJsonResponse = await fetch(`${origin}/health/live`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJsonResponse.status, 400);
    assert.deepEqual(await invalidJsonResponse.json(), {
      statusCode: 400,
      message: "Invalid request body",
    });

    const compressedResponse = await fetch(`${origin}/health/live`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "{}",
    });
    assert.equal(compressedResponse.status, 415);
    assert.deepEqual(await compressedResponse.json(), {
      statusCode: 415,
      message: "Unsupported request encoding",
    });

    const oversizedResponse = await fetch(`${origin}/health/live`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("x".repeat(MAX_REQUEST_BODY_BYTES)),
    });
    assert.equal(oversizedResponse.status, 413);
    assert.deepEqual(await oversizedResponse.json(), {
      statusCode: 413,
      message: "Request body exceeds the allowed size",
    });
  } finally {
    await app.close();
  }
});
