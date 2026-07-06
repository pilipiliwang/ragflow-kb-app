import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/database.js";
import { JobRunner } from "../src/jobQueue.js";

test("JobRunner completes queued jobs and stores results", async () => {
  process.env.APP_SECRET = "job-runner-secret";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-kb-job-"));
  const db = await createDatabase(path.join(dir, "app.sqlite"));
  const runner = new JobRunner(db, {
    echo: async (payload, job) => {
      await job.updateProgress(50, { halfway: true });
      return { echoed: payload.value };
    }
  });

  const job = db.createJob("echo", { value: "ok" });
  await db.save();
  await runner.drain();

  const saved = db.getJob(job.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.progress, 100);
  assert.deepEqual(saved.result, { echoed: "ok" });
});
