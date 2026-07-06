import assert from "node:assert/strict";
import test from "node:test";
import { createAccessCookie, hasAccess, verifyInviteCode } from "../src/auth.js";

test("invite codes gate access", () => {
  process.env.APP_INVITE_CODES = "alpha,beta";
  process.env.APP_SECRET = "test-secret";

  assert.equal(verifyInviteCode("alpha"), true);
  assert.equal(verifyInviteCode("gamma"), false);

  const cookie = createAccessCookie("beta");
  assert.equal(hasAccess({ headers: { cookie: `rag_kb_access=${encodeURIComponent(cookie)}` } }), true);
  assert.equal(hasAccess({ headers: { cookie: "rag_kb_access=broken" } }), false);
});
