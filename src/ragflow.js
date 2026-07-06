function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
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

    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`RAGFlow HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") || text.trim().startsWith("data:")) {
      return { answer: parseSse(text) };
    }
    if (!text) return {};
    return unwrapRagflowJson(JSON.parse(text));
  }

  async health() {
    const response = await this.fetch(`${this.baseUrl}/api/v1/system/healthz`, {
      headers: { Authorization: `Bearer ${this.apiKey}` }
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  }

  async listDatasets(name) {
    const data = await this.request(`/api/v1/datasets${queryString({ name })}`);
    return Array.isArray(data) ? data : data?.datasets || [];
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
    const data = await this.request(`/api/v1/chats${queryString({ name })}`);
    return Array.isArray(data) ? data : data?.chats || [];
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

  async uploadUrl(datasetId, url) {
    const form = new FormData();
    form.append("name", url);
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
    return this.request(`/api/v1/datasets/${datasetId}/chunks`, {
      method: "POST",
      body: { document_ids: ids }
    });
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
    const existing = datasets.find((item) => item.name === settings.ragflowDatasetName) || datasets[0];
    const dataset = existing || await client.createDataset({ name: settings.ragflowDatasetName });
    datasetId = dataset.id;
    if (!datasetId) throw new Error("RAGFlow did not return a dataset id.");
    db.setSettingValue("ragflowDatasetId", datasetId, false);
  }

  let chatId = settings.ragflowChatId;
  if (!chatId) {
    const chats = await client.listChats(settings.ragflowChatName);
    const existing = chats.find((item) => item.name === settings.ragflowChatName) || chats[0];
    const chat = existing || await client.createChat({
      name: settings.ragflowChatName,
      datasetIds: [datasetId],
      llmId: settings.ragflowChatModel
    });
    chatId = chat.id;
    if (!chatId) throw new Error("RAGFlow did not return a chat assistant id.");
    db.setSettingValue("ragflowChatId", chatId, false);
  }

  return {
    client,
    datasetId,
    chatId
  };
}
