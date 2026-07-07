import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashValue } from "./crypto.js";
import { ensureRagflowResources, normalizeRunState } from "./ragflow.js";

const execFileAsync = promisify(execFile);

function documentIdFrom(uploadResult) {
  return uploadResult?.id || uploadResult?.document_id || uploadResult?.doc_id || "";
}

function titleFromFile(file) {
  return file.originalname || "Uploaded file";
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function documentNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/home";
    const raw = `${parsed.hostname}${path}`;
    const slug = raw
      .replace(/^www\./i, "")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
    return slug || "web-page";
  } catch {
    return "web-page";
  }
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    });
}

function extractTitle(html, fallback) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities(match?.[1] || "").replace(/\s+/g, " ").trim() || fallback;
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|h[1-6]|tr|table|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function errorMessage(error) {
  const code = error?.cause?.code || error?.code || "";
  return code ? `${error.message} (${code})` : error.message;
}

function commandErrorMessage(error) {
  const text = String(error?.stderr || error?.message || "command failed").trim();
  return text.split(/\r?\n/).find(Boolean)?.slice(0, 400) || "command failed";
}

async function fetchDirectUrlAsText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.URL_FETCH_TIMEOUT_MS || 20000));
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "RAGFlow-KB-App/0.1 (+https://github.com/pilipiliwang/ragflow-kb-app)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    const fallbackTitle = titleFromUrl(url);
    const title = contentType.includes("html") ? extractTitle(body, fallbackTitle) : fallbackTitle;
    const text = contentType.includes("html") ? htmlToText(body) : body.trim();
    if (!text) throw new Error("Fetched page has no readable text.");
    return {
      title,
      contentType,
      text: text.slice(0, Number(process.env.URL_FETCH_TEXT_LIMIT || 300000)),
      mode: "direct-fetch"
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("URL fetch timed out.");
    throw new Error(errorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchReaderUrlAsText(url, directError) {
  if (process.env.URL_READER_FALLBACK === "false") throw directError;
  const readerBaseUrl = process.env.URL_READER_BASE_URL || "https://r.jina.ai/http://r.jina.ai/http://";
  const readerUrl = `${readerBaseUrl}${url}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.URL_READER_TIMEOUT_MS || 30000));
  try {
    const response = await fetch(readerUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "RAGFlow-KB-App/0.1 (+https://github.com/pilipiliwang/ragflow-kb-app)",
        accept: "text/plain, text/markdown, */*;q=0.2"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = (await response.text()).trim();
    if (!text) throw new Error("Reader returned no readable text.");
    return readerTextResult(url, text, response.headers.get("content-type") || "text/markdown", "reader-fetch");
  } catch (error) {
    const readerError = error.name === "AbortError"
      ? new Error("reader fallback timed out.")
      : new Error(`reader fallback failed: ${errorMessage(error)}`);
    return fetchReaderUrlViaSystem(url, readerUrl, directError, readerError);
  } finally {
    clearTimeout(timeout);
  }
}

function readerTextResult(url, text, contentType, mode) {
  return {
    title: text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || titleFromUrl(url),
    contentType,
    text: text.slice(0, Number(process.env.URL_FETCH_TEXT_LIMIT || 300000)),
    mode
  };
}

async function fetchReaderUrlViaSystem(url, readerUrl, directError, readerError) {
  if (process.platform !== "win32" || process.env.URL_READER_SYSTEM_FETCH === "false") {
    throw new Error(`${directError.message}; ${readerError.message}`);
  }
  const timeoutSec = Math.ceil(Number(process.env.URL_READER_TIMEOUT_MS || 30000) / 1000);
  const script = [
    "& { param($ReaderUrl, $TimeoutSec)",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$response = Invoke-WebRequest -UseBasicParsing -Uri $ReaderUrl -TimeoutSec ([int]$TimeoutSec)",
    "if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw \"HTTP $($response.StatusCode)\" }",
    "Write-Output $response.Content",
    "}"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      readerUrl,
      String(timeoutSec)
    ], {
      timeout: Number(process.env.URL_READER_TIMEOUT_MS || 30000) + 5000,
      maxBuffer: Number(process.env.URL_READER_MAX_BUFFER || 5 * 1024 * 1024)
    });
    const text = stdout.trim();
    if (!text) throw new Error("system reader fetch returned no readable text.");
    return readerTextResult(url, text, "text/markdown", "system-reader-fetch");
  } catch (systemError) {
    throw new Error(`${directError.message}; ${readerError.message}; system reader fallback failed: ${commandErrorMessage(systemError)}`);
  }
}

async function fetchUrlAsText(url) {
  try {
    return await fetchDirectUrlAsText(url);
  } catch (directError) {
    return fetchReaderUrlAsText(url, directError);
  }
}

async function uploadFetchedUrlAsFile(client, datasetId, normalizedUrl, webError) {
  const fetched = await fetchUrlAsText(normalizedUrl);
  const name = documentNameFromUrl(normalizedUrl);
  const body = [
    `Title: ${fetched.title}`,
    `URL: ${normalizedUrl}`,
    `Fetched-At: ${new Date().toISOString()}`,
    `Content-Type: ${fetched.contentType || "unknown"}`,
    "",
    fetched.text
  ].join("\n");
  const buffer = Buffer.from(body, "utf8");
  const uploaded = await client.uploadFile(datasetId, {
    buffer,
    originalname: `${name}.txt`,
    mimetype: "text/plain",
    size: buffer.byteLength
  });
  return {
    uploaded,
    mode: fetched.mode,
    title: fetched.title,
    size: buffer.byteLength,
    statusMessage: fetched.mode === "reader-fetch" || fetched.mode === "system-reader-fetch"
      ? `RAGFlow web crawler failed (${webError.message}); direct backend fetch was blocked, reader fallback fetched readable text and uploaded it as a text document.`
      : `RAGFlow web crawler failed (${webError.message}); backend fetched readable text and uploaded it as a text document.`
  };
}

async function uploadUrlDocument(client, datasetId, normalizedUrl) {
  const name = documentNameFromUrl(normalizedUrl);
  try {
    const uploaded = await client.uploadUrl(datasetId, normalizedUrl, { name });
    return {
      uploaded,
      mode: "ragflow-web",
      title: uploaded?.name || uploaded?.title || titleFromUrl(normalizedUrl),
      size: uploaded?.size || 0,
      statusMessage: "URL imported by RAGFlow web crawler and parse requested."
    };
  } catch (webError) {
    try {
      return await uploadFetchedUrlAsFile(client, datasetId, normalizedUrl, webError);
    } catch (fallbackError) {
      throw new Error(`RAGFlow web crawler failed: ${webError.message}; backend URL fetch fallback failed: ${fallbackError.message}`);
    }
  }
}

async function waitForParse(source, db, client, datasetId, documentId, contextMessage = "") {
  const parsed = await client.waitForDocumentParsed(datasetId, documentId);
  const ready = parsed.status === "ready";
  return db.updateSourceStatus(source.id, {
    status: ready ? "ready" : "parsing",
    statusMessage: [
      contextMessage,
      ready
        ? "Parsed by RAGFlow and ready for retrieval."
        : "Parse requested; RAGFlow is still processing the document."
    ].filter(Boolean).join(" "),
    refreshedAt: new Date().toISOString()
  });
}

function parseStatusMessage(document, status) {
  if (status === "ready") return "已解析完成，可参与 RAG 检索。";

  const rawMessage = String(
    document?.error
      || document?.status_message
      || document?.progress_msg
      || document?.message
      || ""
  ).trim();
  const hasEmbeddingError = /embedding|dashscope|ssl|httpsconnectionpool|max retries/i.test(rawMessage);

  if (status === "error") {
    if (hasEmbeddingError) {
      return "解析失败：向量化模型连接失败，请检查 embedding 模型、API Key 或网络后重试。";
    }
    const lastLine = rawMessage.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    return lastLine ? `解析失败：${lastLine.slice(0, 180)}` : "RAG 资料解析失败。";
  }

  if (hasEmbeddingError) {
    return "RAG 正在解析；部分页段向量化请求失败，可能是 embedding 服务网络不稳定。";
  }
  return rawMessage && rawMessage.length < 180
    ? rawMessage
    : "RAG 正在解析，稍后刷新查看结果。";
}

export async function importFileSource(db, file) {
  const settings = db.getSettings({ includeSecrets: true });
  const resources = await ensureRagflowResources(db, settings);
  await db.save();

  let source = db.upsertSource({
    kind: "file",
    title: titleFromFile(file),
    fileName: file.originalname,
    ragflowDatasetId: resources.datasetId,
    ragflowDocumentId: "",
    status: "uploading",
    statusMessage: "Uploading to RAGFlow.",
    size: file.size,
    contentHash: hashValue(file.buffer),
    refreshedAt: new Date().toISOString()
  });
  await db.save();

  try {
    const uploaded = await resources.client.uploadFile(resources.datasetId, file);
    const documentId = documentIdFrom(uploaded);
    source = db.updateSourceStatus(source.id, {
      title: uploaded?.name || uploaded?.title || source.title,
      ragflowDocumentId: documentId,
      status: "parsing",
      statusMessage: "Uploaded to RAGFlow and parse requested.",
      refreshedAt: new Date().toISOString()
    });
    await db.save();
    await resources.client.parseDocuments(resources.datasetId, [documentId]);
    source = await waitForParse(source, db, resources.client, resources.datasetId, documentId);
    await db.save();
    return source;
  } catch (error) {
    db.updateSourceStatus(source.id, {
      status: "error",
      statusMessage: error.message
    });
    await db.save();
    throw error;
  }
}

export async function refreshUrlSource(db, url) {
  const normalizedUrl = new URL(url).toString();
  const settings = db.getSettings({ includeSecrets: true });
  const resources = await ensureRagflowResources(db, settings);
  await db.save();

  const existing = db.getSourceByUrl(normalizedUrl);
  let source = db.upsertSource({
    id: existing?.id,
    kind: "url",
    title: existing?.title || titleFromUrl(normalizedUrl),
    url: normalizedUrl,
    ragflowDatasetId: existing?.ragflow_dataset_id || resources.datasetId,
    ragflowDocumentId: existing?.ragflow_document_id || "",
    status: "refreshing",
    statusMessage: "Refreshing URL in RAGFlow.",
    size: 0,
    contentHash: existing?.content_hash || "",
    refreshedAt: existing?.refreshed_at || null
  });
  await db.save();

  let deleteWarning = "";
  if (existing?.ragflow_document_id) {
    try {
      await resources.client.deleteDocument(
        existing.ragflow_dataset_id || resources.datasetId,
        existing.ragflow_document_id
      );
    } catch (error) {
      deleteWarning = `Old document deletion failed; continuing refresh: ${error.message}`;
      db.updateSourceStatus(source.id, { statusMessage: deleteWarning });
      await db.save();
    }
  }

  try {
    const uploadResult = await uploadUrlDocument(resources.client, resources.datasetId, normalizedUrl);
    const uploaded = uploadResult.uploaded;
    const documentId = documentIdFrom(uploaded);
    if (!documentId) throw new Error("RAGFlow URL import did not return a document id.");
    source = db.updateSourceStatus(source.id, {
      title: uploadResult.title || uploaded?.name || uploaded?.title || titleFromUrl(normalizedUrl),
      ragflowDatasetId: resources.datasetId,
      ragflowDocumentId: documentId,
      status: "parsing",
      statusMessage: [
        deleteWarning,
        uploadResult.statusMessage
      ].filter(Boolean).join(" "),
      size: uploadResult.size || uploaded?.size || source.size,
      contentHash: hashValue(`${normalizedUrl}:${Date.now()}`),
      refreshedAt: new Date().toISOString()
    });
    await db.save();
    await resources.client.parseDocuments(resources.datasetId, [documentId]);
    const contextMessage = uploadResult.mode === "direct-fetch"
      ? "RAGFlow web crawler failed; backend fetched readable text instead."
      : uploadResult.mode === "reader-fetch" || uploadResult.mode === "system-reader-fetch"
        ? "RAGFlow web crawler failed; reader fallback fetched readable text instead."
        : "";
    source = await waitForParse(source, db, resources.client, resources.datasetId, documentId, contextMessage);
    await db.save();
    return source;
  } catch (error) {
    db.updateSourceStatus(source.id, {
      status: "error",
      statusMessage: error.message
    });
    await db.save();
    throw error;
  }
}

export async function refreshAllUrlSources(db) {
  const warnings = [];
  const refreshed = [];
  const sources = db.listUrlSources();

  for (const source of sources) {
    try {
      const updated = await refreshUrlSource(db, source.url);
      refreshed.push(updated);
    } catch (error) {
      warnings.push({
        sourceId: source.id,
        url: source.url,
        error: error.message
      });
      db.updateSourceStatus(source.id, {
        status: "error",
        statusMessage: error.message
      });
      await db.save();
    }
  }

  return { refreshed, warnings };
}

export async function syncSourceStatuses(db) {
  const sources = db.listSources()
    .filter((source) => source.ragflow_document_id)
    .filter((source) => (
      ["uploading", "parsing", "refreshing", "pending", "error"].includes(source.status)
      || (source.status === "ready" && source.status_message !== "已解析完成，可参与 RAG 检索。")
    ));

  if (!sources.length) return db.listSources();

  const settings = db.getSettings({ includeSecrets: true });
  let resources;
  try {
    resources = await ensureRagflowResources(db, settings);
  } catch {
    return db.listSources();
  }
  let changed = false;

  for (const source of sources) {
    try {
      const document = await resources.client.getDocument(
        source.ragflow_dataset_id || resources.datasetId,
        source.ragflow_document_id
      );
      const status = normalizeRunState(document);
      if (status !== "ready" && status !== "error" && status !== "parsing") continue;

      db.updateSourceStatus(source.id, {
        status,
        statusMessage: parseStatusMessage(document, status),
        refreshedAt: new Date().toISOString()
      });
      changed = true;
    } catch (error) {
      db.updateSourceStatus(source.id, {
        status: "error",
        statusMessage: error.message
      });
      changed = true;
    }
  }

  if (changed) await db.save();
  return db.listSources();
}

export async function removeSource(db, sourceId) {
  const source = db.getSource(sourceId);
  if (!source) return false;
  const settings = db.getSettings({ includeSecrets: true });
  const resources = await ensureRagflowResources(db, settings);
  if (source.ragflow_document_id) {
    await resources.client.deleteDocument(
      source.ragflow_dataset_id || resources.datasetId,
      source.ragflow_document_id
    );
  }
  db.deleteSource(sourceId);
  await db.save();
  return true;
}
