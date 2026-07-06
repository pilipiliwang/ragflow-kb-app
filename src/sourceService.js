import { hashValue } from "./crypto.js";
import { ensureRagflowResources } from "./ragflow.js";

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

export async function importFileSource(db, file) {
  const settings = db.getSettings({ includeSecrets: true });
  const resources = await ensureRagflowResources(db, settings);
  await db.save();

  const uploaded = await resources.client.uploadFile(resources.datasetId, file);
  const documentId = documentIdFrom(uploaded);
  await resources.client.parseDocuments(resources.datasetId, [documentId]);

  const source = db.upsertSource({
    kind: "file",
    title: titleFromFile(file),
    fileName: file.originalname,
    ragflowDatasetId: resources.datasetId,
    ragflowDocumentId: documentId,
    status: "parsing",
    statusMessage: "Uploaded to RAGFlow and parse requested.",
    size: file.size,
    contentHash: hashValue(file.buffer),
    refreshedAt: new Date().toISOString()
  });
  await db.save();
  return source;
}

export async function refreshUrlSource(db, url) {
  const normalizedUrl = new URL(url).toString();
  const settings = db.getSettings({ includeSecrets: true });
  const resources = await ensureRagflowResources(db, settings);
  await db.save();

  const existing = db.getSourceByUrl(normalizedUrl);
  if (existing?.ragflow_document_id) {
    try {
      await resources.client.deleteDocument(
        existing.ragflow_dataset_id || resources.datasetId,
        existing.ragflow_document_id
      );
    } catch (error) {
      db.updateSourceStatus(existing.id, {
        status: "refreshing",
        statusMessage: `Old document deletion failed; continuing refresh: ${error.message}`
      });
    }
  }

  const uploaded = await resources.client.uploadUrl(resources.datasetId, normalizedUrl);
  const documentId = documentIdFrom(uploaded);
  await resources.client.parseDocuments(resources.datasetId, [documentId]);

  const source = db.upsertSource({
    id: existing?.id,
    kind: "url",
    title: uploaded?.name || uploaded?.title || titleFromUrl(normalizedUrl),
    url: normalizedUrl,
    ragflowDatasetId: resources.datasetId,
    ragflowDocumentId: documentId,
    status: "parsing",
    statusMessage: "URL imported to RAGFlow and parse requested.",
    size: 0,
    contentHash: hashValue(`${normalizedUrl}:${Date.now()}`),
    refreshedAt: new Date().toISOString()
  });
  await db.save();
  return source;
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
