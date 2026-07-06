import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareAnswers } from "../src/compareService.js";
import { createDatabase } from "../src/database.js";

function response(data) {
  return new Response(JSON.stringify({ code: 0, data }), {
    headers: { "content-type": "application/json" }
  });
}

test("compareAnswers calls RAGFlow and direct model then stores history", async () => {
  process.env.APP_SECRET = "compare-secret";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-kb-compare-"));
  const db = await createDatabase(path.join(dir, "app.sqlite"));
  db.updateSettings({
    ragflowBaseUrl: "http://ragflow.mock",
    ragflowApiKey: "rag-key",
    ragflowDatasetName: "kb",
    ragflowChatName: "assistant",
    directBaseUrl: "http://model.mock/v1",
    directApiKey: "model-key",
    directModel: "direct-model"
  });
  await db.save();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl.startsWith("http://ragflow.mock/api/v1/datasets?")) return response([]);
    if (textUrl.endsWith("/api/v1/datasets") && options.method === "POST") return response({ id: "ds1" });
    if (textUrl.startsWith("http://ragflow.mock/api/v1/chats?")) return response([]);
    if (textUrl.endsWith("/api/v1/chats") && options.method === "POST") return response({ id: "chat1" });
    if (textUrl.endsWith("/api/v1/chat/completions")) {
      return response({
        answer: "RAGFlow answer",
        reference: { chunks: [{ document_id: "doc1", content: "matched source" }] }
      });
    }
    if (textUrl.endsWith("/v1/chat/completions")) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Direct answer" } }],
        usage: { total_tokens: 10 }
      }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${textUrl}`);
  };

  try {
    const result = await compareAnswers(db, { question: "How?", refreshUrls: false });
    assert.equal(result.rag.answer, "RAGFlow answer");
    assert.equal(result.direct.answer, "Direct answer");
    assert.equal(result.rag.references[0].content, "matched source");
    const history = db.listQaHistory({ limit: 10 });
    assert.equal(history.count, 1);
    assert.equal(history.rows[0].question, "How?");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
