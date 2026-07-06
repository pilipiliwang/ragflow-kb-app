import assert from "node:assert/strict";
import test from "node:test";
import { createAccessCookie, hasAccess, verifyExternalApiKey, verifyInviteCode } from "../src/auth.js";

test("invite codes gate access", () => {
  process.env.APP_INVITE_CODES = "alpha,beta";
  process.env.APP_SECRET = "test-secret";

  assert.equal(verifyInviteCode("alpha"), true);
  assert.equal(verifyInviteCode("gamma"), false);

  const cookie = createAccessCookie("beta");
  assert.equal(hasAccess({ headers: { cookie: `rag_kb_access=${encodeURIComponent(cookie)}` } }), true);
  assert.equal(hasAccess({ headers: { cookie: "rag_kb_access=broken" } }), false);
});

test("external API keys accept bearer and x-api-key headers", () => {
  process.env.EXTERNAL_API_KEYS = "";
  const settings = { externalApiKeys: "first-key\nsecond-key" };

  assert.equal(
    verifyExternalApiKey({ headers: { authorization: "Bearer first-key" } }, settings),
    true
  );
  assert.equal(
    verifyExternalApiKey({ headers: { "x-api-key": "second-key" } }, settings),
    true
  );
  assert.equal(
    verifyExternalApiKey({ headers: { authorization: "Bearer wrong-key" } }, settings),
    false
  );
});
