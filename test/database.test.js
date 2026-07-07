import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, importPortableData } from "../src/database.js";

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
    availableModels: "gpt-test\nother-model",
    externalApiKeys: "web-key"
  });
  await db.save();

  const publicSettings = db.getSettings();
  assert.equal(publicSettings.ragflowApiKey, undefined);
  assert.equal(publicSettings.secrets.ragflowApiKey, true);
  assert.equal(publicSettings.secrets.externalApiKeys, true);
  assert.deepEqual(publicSettings.availableModels, ["gpt-test", "other-model"]);

  db.updateSettings({ ragflowApiKey: "", directModel: "gpt-new" });
  const preserved = db.getSettings({ includeSecrets: true });
  assert.equal(preserved.ragflowApiKey, "rag-key");
  assert.equal(preserved.directModel, "gpt-new");

  const reopened = await createDatabase(dbPath);
  assert.equal(reopened.getSettings({ includeSecrets: true }).directApiKey, "direct-key");
});

test("jobs are persisted and parsed", async () => {
  process.env.APP_SECRET = "jobs-secret";
  const dbPath = await tempDbPath();
  const db = await createDatabase(dbPath);

  const job = db.createJob("refresh_urls", { urls: ["https://example.com"] });
  db.updateJob(job.id, {
    status: "completed",
    progress: 100,
    result: { imported: 1 },
    finishedAt: "2026-01-01T00:00:00.000Z"
  });
  await db.save();

  const reopened = await createDatabase(dbPath);
  const saved = reopened.getJob(job.id);
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.payload, { urls: ["https://example.com"] });
  assert.deepEqual(saved.result, { imported: 1 });
  assert.equal(reopened.listJobs({ limit: 10 }).count, 1);
});

test("legacy portable data is imported without secrets", async () => {
  process.env.APP_SECRET = "legacy-import-secret";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-kb-legacy-"));
  const mainPath = path.join(dir, "app.sqlite");
  const legacyPath = path.join(dir, "local-api.sqlite");

  const legacy = await createDatabase(legacyPath);
  legacy.upsertSource({
    id: "src-legacy",
    kind: "file",
    title: "Legacy.pdf",
    fileName: "Legacy.pdf",
    ragflowDatasetId: "ds1",
    ragflowDocumentId: "doc1",
    status: "ready",
    statusMessage: "ready"
  });
  legacy.addQaHistory({
    question: "legacy question",
    ragAnswer: "legacy answer",
    directAnswer: "direct answer",
    ragReferences: [],
    warnings: [],
    errors: [],
    timings: {}
  });
  const job = legacy.createJob("refresh_urls", { urls: ["https://example.com"] });
  legacy.updateJob(job.id, { status: "completed", progress: 100, result: { ok: true } });
  legacy.updateSettings({ directApiKey: "do-not-import" });
  await legacy.save();

  const main = await createDatabase(mainPath);
  const result = await importPortableData(main, legacyPath);

  assert.equal(result.sources, 1);
  assert.equal(result.qaHistory, 1);
  assert.equal(result.jobs, 1);
  assert.equal(main.listSources().length, 1);
  assert.equal(main.listQaHistory({ limit: 10 }).count, 1);
  assert.equal(main.listJobs({ limit: 10 }).count, 1);
  assert.equal(main.getSettings({ includeSecrets: true }).directApiKey, "");

  const secondResult = await importPortableData(main, legacyPath);
  assert.equal(secondResult.sources, 0);
  assert.equal(secondResult.qaHistory, 0);
  assert.equal(secondResult.jobs, 0);
});
