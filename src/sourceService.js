import { hashValue } from "./crypto.js";
import { ensureRagflowResources, normalizeRunState } from "./ragflow.js";

function documentIdFrom(uploadResult) {
  return uploadResult?.id || uploadResult?.document_id || uploadResult?.doc_id || "";
}

function titleFromFile(file) {
  return file.originalname || "Uploaded file";
}

function titleFromUrl(url) {
  try {
    return new URL(url).hostname + new URL(url).pathname;
  } catch {
    return url;
  }
}

async function waitForParse(source, db, client, datasetId, documentId) {
  const parsed = await client.waitForDocumentParsed(datasetId, documentId);
  const ready = parsed.status === "ready";
  return db.updateSourceStatus(source.id, {
    status: ready ? "ready" : "parsing",
    statusMessage: ready
      ? "Parsed by RAGFlow and ready for retrieval."
      : "Parse requested; RAGFlow is still processing the document.",
    refreshedAt: new Date().toISOString()
  });
}

function parseStatusMessage(document, status) {
  if (status === "ready") return "Parsed by RAGFlow and ready for retrieval.";
  if (status === "error") {
    return document?.error
      || document?.status_message
      || document?.progress_msg
      || "RAGFlow document parse failed.";
  }
  return document?.progress_msg || "Parse requested; RAGFlow is still processing the document.";
}

export async function importFileSource(db, file) {
  const settings = db.getSettings({ includeSecrets: true });
  let resources;
  try {
    resources = await ensureRagflowResources(db, settings);
  } catch {
    return db.listSources();
  }
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
    const uploaded = await resources.client.uploadUrl(resources.datasetId, normalizedUrl);
    const documentId = documentIdFrom(uploaded);
    source = db.updateSourceStatus(source.id, {
      title: uploaded?.name || uploaded?.title || titleFromUrl(normalizedUrl),
      ragflowDatasetId: resources.datasetId,
      ragflowDocumentId: documentId,
      status: "parsing",
      statusMessage: [
        deleteWarning,
        "URL imported to RAGFlow and parse requested."
      ].filter(Boolean).join(" "),
      contentHash: hashValue(`${normalizedUrl}:${Date.now()}`),
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
    .filter((source) => ["uploading", "parsing", "refreshing", "pending"].includes(source.status));

  if (!sources.length) return db.listSources();

  const settings = db.getSettings({ includeSecrets: true });
  const resources = await ensureRagflowResources(db, settings);
  let changed = false;

  for (const source of sources) {
    try {
      const document = await resources.client.getDocument(
        source.ragflow_dataset_id || resources.datasetId,
        source.ragflow_document_id
      );
      const status = normalizeRunState(document);
      if (status !== "ready" && status !== "error") continue;

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
