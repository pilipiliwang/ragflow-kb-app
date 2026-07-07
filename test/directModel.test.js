import assert from "node:assert/strict";
import test from "node:test";
import { answerDirectly } from "../src/directModel.js";

test("answerDirectly normalizes direct model API key", async () => {
  let authHeader = "";
  const result = await answerDirectly({
    directBaseUrl: "https://api.minimax.io/v1",
    directApiKey: "Bearer test-key",
    directModel: "MiniMax-M3"
  }, "hello", async (_url, options = {}) => {
    authHeader = options.headers.authorization;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "OK" } }]
    }), {
      headers: { "content-type": "application/json" }
    });
  });

  assert.equal(authHeader, "Bearer test-key");
  assert.equal(result.answer, "OK");
});

test("answerDirectly surfaces provider auth errors clearly", async () => {
  await assert.rejects(
    () => answerDirectly({
      directBaseUrl: "https://api.minimaxi.com/v1",
      directApiKey: "bad-key",
      directModel: "MiniMax-M3"
    }, "hello", async () => new Response(JSON.stringify({
      type: "error",
      error: {
        type: "authorized_error",
        message: "invalid api key (2049)",
        http_code: "401"
      }
    }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })),
    /MiniMax API Key 无效/
  );
});
