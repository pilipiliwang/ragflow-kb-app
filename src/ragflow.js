function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryString(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function parseSse(text) {
  const chunks = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const answer = parsed.data?.answer || parsed.answer || parsed.choices?.[0]?.delta?.content;
      if (answer) chunks.push(answer);
    } catch {
      chunks.push(data);
    }
  }
  return chunks.join("");
}

function unwrapRagflowJson(json) {
  if (json?.code && json.code !== 0 && json.code !== "0") {
    throw new Error(json.message || json.msg || `RAGFlow returned code ${json.code}`);
  }
  return json?.data ?? json;
}

function isNoParsedFileError(error) {
  return String(error?.message || "").includes("doesn't own parsed file");
}

function isMissingEndpointError(error) {
  return /HTTP (404|405)|not found|method not allowed/i.test(String(error?.message || ""));
}

function chatDatasetIds(chat) {
  if (Array.isArray(chat?.dataset_ids)) return chat.dataset_ids;
  if (Array.isArray(chat?.kb_ids)) return chat.kb_ids;
  return [];
}

function documentList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.documents)) return data.documents;
  if (Array.isArray(data?.docs)) return data.docs;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

export function normalizeRunState(document) {
  const raw = String(
    document?.run
      ?? document?.status
      ?? document?.parser_status
      ?? document?.chunking_status
      ?? ""
  ).trim().toLowerCase();

  if (!raw) return "unknown";
  if (["done", "ready", "parsed", "success", "succeeded", "completed", "finished", "3"].includes(raw)) return "ready";
  if (["fail", "failed", "error", "cancel", "cancelled", "canceled", "-1", "4"].includes(raw)) return "error";
  if (["running", "parsing", "chunking", "processing", "queued", "pending", "0", "1", "2"].includes(raw)) return "parsing";
  return raw;
}

function normalizeReferences(reference) {
  const chunks = Array.isArray(reference?.chunks)
    ? reference.chunks
    : Array.isArray(reference)
      ? reference
      : [];

  return chunks.slice(0, 12).map((item, index) => ({
    index: index + 1,
    documentId: item.document_id || item.doc_id || item.id || "",
    documentName: item.document_name || item.doc_name || item.name || "",
    url: item.url || item.metadata?.url || "",
    content: item.content || item.text || "",
    score: item.similarity || item.score || item.vector_similarity || null
  }));
}

export class RagflowClient {
  constructor(settings, fetchImpl = fetch) {
    this.baseUrl = normalizeBaseUrl(settings.ragflowBaseUrl);
    this.apiKey = settings.ragflowApiKey;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = numberEnv("RAGFLOW_REQUEST_TIMEOUT_MS", 30000);
    this.requestRetries = numberEnv("RAGFLOW_REQUEST_RETRIES", 2);
    this.parseWaitMs = numberEnv("RAGFLOW_PARSE_WAIT_MS", 45000);
    this.parsePollMs = numberEnv("RAGFLOW_PARSE_POLL_MS", 3000);
    if (!this.baseUrl) throw new Error("RAGFlow base URL is not configured.");
    if (!this.apiKey) throw new Error("RAGFlow API key is not configured.");
  }

  async request(path, options = {}) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(options.headers || {})
    };

    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== "string") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(body);
    }

    const method = options.method || "GET";
    const retryLimit = body instanceof FormData ? 0 : this.requestRetries;
    let lastError;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.requestTimeoutMs);
      try {
        const response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal
        });

        const text = await response.text();
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new Error(`RAGFlow HTTP ${response.status}: ${text.slice(0, 500)}`);
          if (retryable && attempt < retryLimit) {
            lastError = error;
            await sleep(300 * (attempt + 1));
            continue;
          }
          throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream") || text.trim().startsWith("data:")) {
          return { answer: parseSse(text) };
        }
        if (!text) return {};
        return unwrapRagflowJson(JSON.parse(text));
      } catch (error) {
        lastError = error.name === "AbortError"
          ? new Error(`RAGFlow request timed out after ${options.timeoutMs || this.requestTimeoutMs}ms.`)
          : error;
        if (attempt < retryLimit) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async health() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1/system/healthz`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  }

  async listDatasets(name) {
    const data = await this.request("/api/v1/datasets");
    const datasets = Array.isArray(data) ? data : data?.datasets || [];
    return name ? datasets.filter((item) => item.name === name) : datasets;
  }

  async createDataset({ name, embeddingModel }) {
    const payload = { name };
    if (embeddingModel) payload.embedding_model = embeddingModel;
    return this.request("/api/v1/datasets", {
      method: "POST",
      body: payload
    });
  }

  async listChats(name) {
    const data = await this.request("/api/v1/chats");
    const chats = Array.isArray(data) ? data : data?.chats || [];
    return name ? chats.filter((item) => item.name === name) : chats;
  }

  async createChat({ name, datasetIds, llmId }) {
    const payload = {
      name,
      dataset_ids: datasetIds
    };
    if (llmId) payload.llm_id = llmId;
    return this.request("/api/v1/chats", {
      method: "POST",
      body: payload
    });
  }

  async updateChat(chatId, { datasetIds, llmId }) {
    const payload = {
      dataset_ids: datasetIds
    };
    if (llmId) payload.llm_id = llmId;
    return this.request(`/api/v1/chats/${chatId}`, {
      method: "PATCH",
      body: payload
    });
  }

  async uploadFile(datasetId, file) {
    const form = new FormData();
    const blob = new Blob([file.buffer], {
      type: file.mimetype || "application/octet-stream"
    });
    form.append("file", blob, file.originalname);
    const data = await this.request(`/api/v1/datasets/${datasetId}/documents`, {
      method: "POST",
      body: form
    });
    return Array.isArray(data) ? data[0] : data?.[0] || data;
  }

  async uploadUrl(datasetId, url, options = {}) {
    const form = new FormData();
    form.append("name", options.name || url);
    form.append("url", url);
    const data = await this.request(`/api/v1/datasets/${datasetId}/documents?type=web`, {
      method: "POST",
      body: form
    });
    return Array.isArray(data) ? data[0] : data?.[0] || data;
  }

  async deleteDocument(datasetId, documentId) {
    if (!documentId) return null;
    return this.request(`/api/v1/datasets/${datasetId}/documents`, {
      method: "DELETE",
      body: { ids: [documentId] }
    });
  }

  async parseDocuments(datasetId, documentIds) {
    const ids = documentIds.filter(Boolean);
    if (!ids.length) return null;
    try {
      return await this.request(`/api/v1/datasets/${datasetId}/documents/parse`, {
        method: "POST",
        body: { document_ids: ids }
      });
    } catch (error) {
      if (!isMissingEndpointError(error)) throw error;
      return this.request(`/api/v1/datasets/${datasetId}/chunks`, {
        method: "POST",
        body: { document_ids: ids }
      });
    }
  }

  async listDocuments(datasetId, params = {}) {
    const data = await this.request(`/api/v1/datasets/${datasetId}/documents${queryString(params)}`);
    return documentList(data);
  }

  async getDocument(datasetId, documentId) {
    const documents = await this.listDocuments(datasetId, { id: documentId, page_size: 100 });
    return documents.find((item) => {
      const id = item.id || item.document_id || item.doc_id;
      return id === documentId;
    }) || documents[0] || null;
  }

  async waitForDocumentParsed(datasetId, documentId, options = {}) {
    if (!documentId) return { status: "unknown", document: null };
    const waitMs = options.timeoutMs ?? this.parseWaitMs;
    if (waitMs <= 0) return { status: "parsing", document: null };

    const deadline = Date.now() + waitMs;
    let lastDocument = null;
    while (Date.now() <= deadline) {
      const document = await this.getDocument(datasetId, documentId);
      lastDocument = document || lastDocument;
      const status = normalizeRunState(document);
      if (status === "ready") return { status: "ready", document };
      if (status === "error") {
        throw new Error(
          document?.error
            || document?.status_message
            || document?.progress_msg
            || document?.message
            || "RAGFlow document parse failed."
        );
      }
      await sleep(options.pollMs ?? this.parsePollMs);
    }

    return {
      status: "parsing",
      document: lastDocument,
      timedOut: true
    };
  }

  async chat({ chatId, question, model }) {
    const payload = {
      chat_id: chatId,
      question,
      stream: false
    };
    if (model) payload.llm_id = model;

    const data = await this.request("/api/v1/chat/completions", {
      method: "POST",
      body: payload
    });

    return {
      answer: data.answer || data.content || data.message?.content || "",
      references: normalizeReferences(data.reference || data.references),
      raw: data
    };
  }
}

export async function ensureRagflowResources(db, settings) {
  const client = new RagflowClient(settings);
  let datasetId = settings.ragflowDatasetId;

  if (!datasetId) {
    const datasets = await client.listDatasets(settings.ragflowDatasetName);
    const existing = datasets.find((item) => item.name === settings.ragflowDatasetName);
    const dataset = existing || await client.createDataset({ name: settings.ragflowDatasetName });
    datasetId = dataset.id;
    if (!datasetId) throw new Error("RAGFlow did not return a dataset id.");
    db.setSettingValue("ragflowDatasetId", datasetId, false);
  }

  let chatId = settings.ragflowChatId;
  let chat = null;
  if (!chatId) {
    const chats = await client.listChats(settings.ragflowChatName);
    const existing = chats.find((item) => item.name === settings.ragflowChatName);
    if (existing) {
      chat = existing;
    } else {
      try {
        chat = await client.createChat({
          name: settings.ragflowChatName,
          datasetIds: [datasetId],
          llmId: settings.ragflowChatModel
        });
      } catch (error) {
        if (!isNoParsedFileError(error)) throw error;
        chat = await client.createChat({
          name: settings.ragflowChatName,
          datasetIds: [],
          llmId: settings.ragflowChatModel
        });
      }
    }
    chatId = chat.id;
    if (!chatId) throw new Error("RAGFlow did not return a chat assistant id.");
    db.setSettingValue("ragflowChatId", chatId, false);
  }

  if (chatId && datasetId && !chatDatasetIds(chat).includes(datasetId)) {
    try {
      await client.updateChat(chatId, {
        datasetIds: [datasetId],
        llmId: settings.ragflowChatModel
      });
    } catch (error) {
      if (!isNoParsedFileError(error)) throw error;
    }
  }

  return {
    client,
    datasetId,
    chatId
  };
}
