import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../src/database.js";
import { refreshUrlSource } from "../src/sourceService.js";

function ragflowResponse(data, status = 200) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("refreshUrlSource falls back to backend fetch when RAGFlow web crawl fails", async () => {
  process.env.APP_SECRET = "source-service-secret";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-kb-source-"));
  const db = await createDatabase(path.join(dir, "app.sqlite"));
  db.updateSettings({
    ragflowBaseUrl: "http://ragflow.mock",
    ragflowApiKey: "rag-key",
    ragflowDatasetName: "kb",
    ragflowDatasetId: "ds1",
    ragflowChatName: "assistant",
    ragflowChatId: "chat1"
  });
  await db.save();

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    calls.push({ url: textUrl, method: options.method || "GET", body: options.body });
    if (textUrl === "http://ragflow.mock/api/v1/chats/chat1" && options.method === "PATCH") {
      return ragflowResponse({ id: "chat1", dataset_ids: ["ds1"] });
    }
    if (textUrl.endsWith("/api/v1/datasets/ds1/documents?type=web")) {
      return new Response(JSON.stringify({ code: 102, message: "Download failure." }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (textUrl === "https://example.test/page") {
      return new Response("<html><title>Example Title</title><body><h1>Hello</h1><p>Readable page text.</p></body></html>", {
        headers: { "content-type": "text/html" }
      });
    }
    if (textUrl.endsWith("/api/v1/datasets/ds1/documents") && options.method === "POST") {
      return ragflowResponse([{ id: "doc-fallback", name: "example.test-page.txt", size: 120 }]);
    }
    if (textUrl.endsWith("/api/v1/datasets/ds1/documents/parse")) {
      return ragflowResponse({ ok: true });
    }
    if (textUrl.includes("/api/v1/datasets/ds1/documents?")) {
      return ragflowResponse({ documents: [{ id: "doc-fallback", name: "example.test-page.txt", run: "DONE" }] });
    }
    throw new Error(`Unexpected fetch: ${textUrl}`);
  };

  try {
    const source = await refreshUrlSource(db, "https://example.test/page");
    assert.equal(source.status, "ready");
    assert.equal(source.kind, "url");
    assert.equal(source.title, "Example Title");
    assert.equal(source.ragflow_document_id, "doc-fallback");
    assert.match(source.status_message, /Parsed by RAGFlow/);
    const fallbackUpload = calls.find((call) => call.url.endsWith("/api/v1/datasets/ds1/documents") && call.method === "POST");
    assert.ok(fallbackUpload, "expected fallback text file upload");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshUrlSource uses reader fallback when direct backend fetch is blocked", async () => {
  process.env.APP_SECRET = "source-service-reader-secret";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-kb-source-reader-"));
  const db = await createDatabase(path.join(dir, "app.sqlite"));
  db.updateSettings({
    ragflowBaseUrl: "http://ragflow.mock",
    ragflowApiKey: "rag-key",
    ragflowDatasetName: "kb",
    ragflowDatasetId: "ds1",
    ragflowChatName: "assistant",
    ragflowChatId: "chat1"
  });
  await db.save();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === "http://ragflow.mock/api/v1/chats/chat1" && options.method === "PATCH") {
      return ragflowResponse({ id: "chat1", dataset_ids: ["ds1"] });
    }
    if (textUrl.endsWith("/api/v1/datasets/ds1/documents?type=web")) {
      return new Response(JSON.stringify({ code: 102, message: "Download failure." }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (textUrl === "https://blocked.test/page") {
      return new Response("blocked", { status: 403 });
    }
    if (textUrl === "https://r.jina.ai/http://r.jina.ai/http://https://blocked.test/page") {
      return new Response("Title: Reader Title\n\nMarkdown Content:\nReadable reader text.", {
        headers: { "content-type": "text/markdown" }
      });
    }
    if (textUrl.endsWith("/api/v1/datasets/ds1/documents") && options.method === "POST") {
      return ragflowResponse([{ id: "doc-reader", name: "blocked.test-page.txt", size: 120 }]);
    }
    if (textUrl.endsWith("/api/v1/datasets/ds1/documents/parse")) {
      return ragflowResponse({ ok: true });
    }
    if (textUrl.includes("/api/v1/datasets/ds1/documents?")) {
      return ragflowResponse({ documents: [{ id: "doc-reader", name: "blocked.test-page.txt", run: "DONE" }] });
    }
    throw new Error(`Unexpected fetch: ${textUrl}`);
  };

  try {
    const source = await refreshUrlSource(db, "https://blocked.test/page");
    assert.equal(source.status, "ready");
    assert.equal(source.title, "Reader Title");
    assert.equal(source.ragflow_document_id, "doc-reader");
    assert.match(source.status_message, /reader fallback/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
