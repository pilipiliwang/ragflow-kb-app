import assert from "node:assert/strict";
import test from "node:test";
import { RagflowClient } from "../src/ragflow.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("RagflowClient wraps upload, parse, and chat requests", async () => {
  const calls = [];
  const client = new RagflowClient({
    ragflowBaseUrl: "http://ragflow.local",
    ragflowApiKey: "key"
  }, async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    if (url.endsWith("/documents?type=web")) return jsonResponse([{ id: "doc-web" }]);
    if (url.endsWith("/documents")) return jsonResponse([{ id: "doc-file" }]);
    if (url.endsWith("/chunks")) return jsonResponse({ ok: true });
    if (url.endsWith("/chat/completions")) {
      return jsonResponse({
        answer: "RAG answer",
        reference: {
          chunks: [{ document_id: "doc-web", content: "source text", similarity: 0.91 }]
        }
      });
    }
    return jsonResponse({});
  });

  const fileDoc = await client.uploadFile("ds1", {
    buffer: Buffer.from("hello"),
    mimetype: "text/plain",
    originalname: "hello.txt"
  });
  const webDoc = await client.uploadUrl("ds1", "https://example.com");
  await client.parseDocuments("ds1", [fileDoc.id, webDoc.id]);
  const answer = await client.chat({ chatId: "chat1", question: "hello" });

  assert.equal(fileDoc.id, "doc-file");
  assert.equal(webDoc.id, "doc-web");
  assert.equal(answer.answer, "RAG answer");
  assert.equal(answer.references[0].documentId, "doc-web");
  assert.equal(calls.some((call) => call.url.includes("/chunks") && call.method === "POST"), true);
});

test("RagflowClient retries retryable JSON requests", async () => {
  let calls = 0;
  const client = new RagflowClient({
    ragflowBaseUrl: "http://ragflow.local",
    ragflowApiKey: "key"
  }, async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("temporary", { status: 500 });
    }
    return jsonResponse([{ id: "ds1", name: "kb" }]);
  });

  const datasets = await client.listDatasets("kb");
  assert.equal(calls, 2);
  assert.equal(datasets[0].id, "ds1");
});

test("RagflowClient waits for document parse status", async () => {
  let calls = 0;
  const client = new RagflowClient({
    ragflowBaseUrl: "http://ragflow.local",
    ragflowApiKey: "key"
  }, async () => {
    calls += 1;
    return jsonResponse({
      documents: [{
        id: "doc1",
        run: calls < 2 ? "RUNNING" : "DONE"
      }]
    });
  });

  const result = await client.waitForDocumentParsed("ds1", "doc1", {
    timeoutMs: 100,
    pollMs: 1
  });
  assert.equal(result.status, "ready");
  assert.equal(calls, 2);
});
