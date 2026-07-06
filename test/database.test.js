import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/database.js";

async function tempDbPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-kb-db-"));
  return path.join(dir, "app.sqlite");
}

test("settings are encrypted, masked, preserved, and persisted", async () => {
  process.env.APP_SECRET = "unit-test-secret";
  const dbPath = await tempDbPath();
  const db = await createDatabase(dbPath);

  db.updateSettings({
    ragflowBaseUrl: "http://ragflow.test",
    ragflowApiKey: "rag-key",
    directApiKey: "direct-key",
    directModel: "gpt-test",
    availableModels: "gpt-test\nother-model"
  });
  await db.save();

  const publicSettings = db.getSettings();
  assert.equal(publicSettings.ragflowApiKey, undefined);
  assert.equal(publicSettings.secrets.ragflowApiKey, true);
  assert.deepEqual(publicSettings.availableModels, ["gpt-test", "other-model"]);

  db.updateSettings({ ragflowApiKey: "", directModel: "gpt-new" });
  const preserved = db.getSettings({ includeSecrets: true });
  assert.equal(preserved.ragflowApiKey, "rag-key");
  assert.equal(preserved.directModel, "gpt-new");

  const reopened = await createDatabase(dbPath);
  assert.equal(reopened.getSettings({ includeSecrets: true }).directApiKey, "direct-key");
});
