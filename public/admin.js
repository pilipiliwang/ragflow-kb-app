const fields = [
  "ragflowBaseUrl",
  "ragflowApiKey",
  "ragflowDatasetName",
  "ragflowDatasetId",
  "ragflowChatName",
  "ragflowChatId",
  "ragflowChatModel",
  "directBaseUrl",
  "directApiKey",
  "directModel",
  "availableModels",
  "externalApiKeys"
];

const els = Object.fromEntries(fields.map((id) => [id, document.querySelector(`#${id}`)]));
els.saveSettingsButton = document.querySelector("#saveSettingsButton");
els.healthButton = document.querySelector("#healthButton");
els.ensureButton = document.querySelector("#ensureButton");
els.refreshUrlsButton = document.querySelector("#refreshUrlsButton");
els.reloadSourcesButton = document.querySelector("#reloadSourcesButton");
els.reloadQaButton = document.querySelector("#reloadQaButton");
els.reloadJobsButton = document.querySelector("#reloadJobsButton");
els.logoutButton = document.querySelector("#logoutButton");
els.adminNotice = document.querySelector("#adminNotice");
els.adminSources = document.querySelector("#adminSources");
els.qaHistory = document.querySelector("#qaHistory");
els.jobsList = document.querySelector("#jobsList");

function createIcons() {
  if (window.lucide) window.lucide.createIcons();
}

async function requestJson(url, options = {}) {
  try {
    return await window.ragKbApi.json(url, options);
  } catch (error) {
    if (error.status === 401) {
      window.location.href = "./login.html";
      throw new Error("Access required");
    }
    throw error;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN");
}

function log(value) {
  els.adminNotice.textContent = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
}

function statusClass(status) {
  if (status === "error") return "status-error";
  if (status === "parsing" || status === "refreshing") return "status-warn";
  return "status-ok";
}

async function loadSettings() {
  const settings = await requestJson("/api/settings");
  for (const key of fields) {
    if (!els[key]) continue;
    if (key === "availableModels") {
      els[key].value = (settings.availableModels || []).join("\n");
    } else if (key.endsWith("ApiKey") || key.endsWith("ApiKeys")) {
      els[key].value = "";
      els[key].placeholder = settings.secrets?.[key]
        ? "已配置，留空则保持不变"
        : "未配置";
    } else {
      els[key].value = settings[key] || "";
    }
  }
}

async function saveSettings() {
  const payload = {};
  for (const key of fields) {
    if (key === "availableModels") payload[key] = els[key].value;
    else payload[key] = els[key].value.trim();
  }
  if (!payload.ragflowApiKey) delete payload.ragflowApiKey;
  if (!payload.directApiKey) delete payload.directApiKey;
  if (!payload.externalApiKeys) delete payload.externalApiKeys;

  const saved = await requestJson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  log({ saved: true, secrets: saved.secrets });
  await loadSettings();
}

async function checkHealth() {
  const payload = await requestJson("/api/health");
  log(payload);
}

async function ensureRagflow() {
  const payload = await requestJson("/api/admin/ragflow/ensure", { method: "POST" });
  log(payload);
  await loadSettings();
}

async function refreshUrls() {
  const payload = await requestJson("/api/sources/refresh-urls", { method: "POST" });
  log({
    refreshed: payload.refreshed?.length || 0,
    warnings: payload.warnings || []
  });
  await loadSources();
}

async function loadSources() {
  const payload = await requestJson("/api/admin/sources");
  const sources = payload.sources || [];
  if (!sources.length) {
    els.adminSources.innerHTML = `<div class="empty">暂无资料源。</div>`;
    return;
  }

  els.adminSources.innerHTML = sources.map((source) => `
    <article class="source-item">
      <div class="section-title">
        <div>
          <div class="source-title">${escapeHtml(source.title || source.url || source.file_name)}</div>
          <div class="meta-row">
            <span>${source.kind === "url" ? "网页" : "文件"}</span>
            <span class="${statusClass(source.status)}">${escapeHtml(source.status)}</span>
            <span>${formatDate(source.updated_at)}</span>
          </div>
        </div>
        <button class="text-button danger" data-delete-source="${escapeHtml(source.id)}" type="button">删除</button>
      </div>
      <small>${escapeHtml(source.status_message || "")}</small>
      <small>dataset: ${escapeHtml(source.ragflow_dataset_id || "-")} · document: ${escapeHtml(source.ragflow_document_id || "-")}</small>
    </article>
  `).join("");
}

async function deleteSource(id) {
  await requestJson(`/api/admin/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadSources();
}

async function loadQa() {
  const payload = await requestJson("/api/admin/qa?limit=50");
  const rows = payload.rows || [];
  if (!rows.length) {
    els.qaHistory.innerHTML = `<div class="empty">暂无问答历史。</div>`;
    return;
  }

  els.qaHistory.innerHTML = rows.map((row) => `
    <article class="history-item">
      <div class="section-title">
        <h3>${escapeHtml(row.question)}</h3>
        <span class="badge muted-badge">${formatDate(row.created_at)}</span>
      </div>
      <div class="meta-row">
        <span>RAG: ${escapeHtml(row.rag_model || "-")}</span>
        <span>LLM: ${escapeHtml(row.direct_model || "-")}</span>
        ${row.errors?.length ? `<span class="status-error">${row.errors.length} 个错误</span>` : ""}
        ${row.warnings?.length ? `<span class="status-warn">${row.warnings.length} 个警告</span>` : ""}
      </div>
      <div class="history-columns">
        <div>
          <h3>RAG</h3>
          <div class="history-answer">${escapeHtml(row.rag_answer || "无答案")}</div>
        </div>
        <div>
          <h3>LLM大模型</h3>
          <div class="history-answer">${escapeHtml(row.direct_answer || "无答案")}</div>
        </div>
      </div>
    </article>
  `).join("");
}

async function loadJobs() {
  const payload = await requestJson("/api/admin/jobs?limit=30");
  const rows = payload.rows || [];
  if (!rows.length) {
    els.jobsList.innerHTML = `<div class="empty">暂无后台任务。</div>`;
    return;
  }

  els.jobsList.innerHTML = rows.map((job) => `
    <article class="source-item">
      <div class="section-title">
        <div>
          <div class="source-title">${escapeHtml(job.type)}</div>
          <div class="meta-row">
            <span class="${statusClass(job.status)}">${escapeHtml(job.status)}</span>
            <span>${Number(job.progress || 0)}%</span>
            <span>${formatDate(job.updated_at)}</span>
          </div>
        </div>
        <span class="badge muted-badge">${escapeHtml(job.id)}</span>
      </div>
      ${job.error ? `<small class="status-error">${escapeHtml(job.error)}</small>` : ""}
      ${job.result ? `<pre class="mini-log compact-log">${escapeHtml(JSON.stringify(job.result, null, 2))}</pre>` : ""}
    </article>
  `).join("");
}

async function logout() {
  await requestJson("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "./login.html";
}

els.saveSettingsButton.addEventListener("click", () => saveSettings().catch((error) => log(error.message)));
els.healthButton.addEventListener("click", () => checkHealth().catch((error) => log(error.message)));
els.ensureButton.addEventListener("click", () => ensureRagflow().catch((error) => log(error.message)));
els.refreshUrlsButton.addEventListener("click", () => refreshUrls().catch((error) => log(error.message)));
els.reloadSourcesButton.addEventListener("click", () => loadSources().catch((error) => log(error.message)));
els.reloadQaButton.addEventListener("click", () => loadQa().catch((error) => log(error.message)));
els.reloadJobsButton.addEventListener("click", () => loadJobs().catch((error) => log(error.message)));
els.logoutButton.addEventListener("click", logout);
els.adminSources.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-source]");
  if (button) deleteSource(button.dataset.deleteSource).catch((error) => log(error.message));
});

createIcons();
Promise.all([loadSettings(), loadSources(), loadQa(), loadJobs()]).catch((error) => log(error.message));
