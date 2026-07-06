const state = {
  settings: null,
  sources: [],
  busy: false
};

const els = {
  statusText: document.querySelector("#statusText"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  uploadButton: document.querySelector("#uploadButton"),
  urlInput: document.querySelector("#urlInput"),
  urlButton: document.querySelector("#urlButton"),
  refreshSourcesButton: document.querySelector("#refreshSourcesButton"),
  sourceList: document.querySelector("#sourceList"),
  logoutButton: document.querySelector("#logoutButton"),
  questionInput: document.querySelector("#questionInput"),
  modelSelect: document.querySelector("#modelSelect"),
  refreshUrlsToggle: document.querySelector("#refreshUrlsToggle"),
  askButton: document.querySelector("#askButton"),
  notice: document.querySelector("#notice"),
  ragMeta: document.querySelector("#ragMeta"),
  ragAnswer: document.querySelector("#ragAnswer"),
  directMeta: document.querySelector("#directMeta"),
  directAnswer: document.querySelector("#directAnswer"),
  references: document.querySelector("#references")
};

function createIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function setBusy(value) {
  state.busy = value;
  [
    els.uploadButton,
    els.urlButton,
    els.refreshSourcesButton,
    els.askButton,
    els.logoutButton
  ].forEach((button) => {
    button.disabled = value;
  });
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
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusClass(status) {
  if (status === "error") return "status-error";
  if (status === "parsing" || status === "refreshing") return "status-warn";
  return "status-ok";
}

function renderSources() {
  els.statusText.textContent = `${state.sources.length} 个资料源`;
  if (!state.sources.length) {
    els.sourceList.innerHTML = `<div class="empty">暂无资料源。先上传文件或粘贴 URL。</div>`;
    return;
  }

  els.sourceList.innerHTML = state.sources.map((source) => `
    <article class="source-item">
      <div class="source-title">${escapeHtml(source.title || source.url || source.file_name)}</div>
      <div class="meta-row">
        <span>${source.kind === "url" ? "网页" : "文件"}</span>
        <span class="${statusClass(source.status)}">${escapeHtml(source.status)}</span>
        <span>${formatDate(source.refreshed_at || source.updated_at)}</span>
      </div>
      ${source.status_message ? `<small>${escapeHtml(source.status_message)}</small>` : ""}
    </article>
  `).join("");
}

function renderSettings() {
  const models = new Set([
    ...(state.settings?.availableModels || []),
    state.settings?.directModel
  ].filter(Boolean));

  if (!models.size) models.add("");
  els.modelSelect.innerHTML = [...models].map((model) => `
    <option value="${escapeHtml(model)}">${model ? escapeHtml(model) : "未配置模型"}</option>
  `).join("");
  els.modelSelect.value = state.settings?.directModel || "";
}

async function loadSettings() {
  state.settings = await requestJson("/api/settings");
  renderSettings();
}

async function loadSources() {
  const payload = await requestJson("/api/admin/sources");
  state.sources = payload.sources || [];
  renderSources();
}

async function uploadFiles() {
  const files = [...els.fileInput.files];
  if (!files.length) {
    els.notice.textContent = "请选择文件。";
    return;
  }

  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  setBusy(true);
  els.notice.textContent = "正在上传到 RAGFlow 并触发解析...";
  try {
    const payload = await requestJson("/api/sources/upload", {
      method: "POST",
      body: form
    });
    els.notice.textContent = summarizeImport(payload.imported || []);
    els.fileInput.value = "";
    await loadSources();
  } catch (error) {
    els.notice.textContent = `上传失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function addUrls() {
  const urls = els.urlInput.value.trim();
  if (!urls) {
    els.notice.textContent = "请输入 URL。";
    return;
  }

  setBusy(true);
  els.notice.textContent = "正在刷新 URL 并触发 RAGFlow 解析...";
  try {
    const payload = await requestJson("/api/sources/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls })
    });
    els.notice.textContent = summarizeImport(payload.imported || []);
    els.urlInput.value = "";
    await loadSources();
  } catch (error) {
    els.notice.textContent = `URL 导入失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

function summarizeImport(items) {
  if (!items.length) return "没有导入内容。";
  return items.map((item, index) => {
    const name = item.title || item.url || item.file_name || item.fileName || "Untitled";
    return `${index + 1}. ${name}：${item.status || "submitted"}${item.status_message ? `，${item.status_message}` : ""}`;
  }).join("\n");
}

async function saveSelectedModel() {
  const directModel = els.modelSelect.value;
  if (!directModel || directModel === state.settings?.directModel) return;
  await requestJson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directModel })
  });
  await loadSettings();
}

function renderReferences(references) {
  if (!references.length) {
    els.references.innerHTML = `<div class="empty">没有返回引用。</div>`;
    return;
  }

  els.references.innerHTML = references.map((ref) => {
    const title = ref.documentName || ref.documentId || `引用 ${ref.index}`;
    const heading = ref.url
      ? `<a href="${escapeHtml(ref.url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>`
      : `<strong>${escapeHtml(title)}</strong>`;
    const score = ref.score ? `<span>相关度 ${Number(ref.score).toFixed(3)}</span>` : "";
    return `
      <article class="reference-item">
        <div class="meta-row">${heading}${score}</div>
        <div>${escapeHtml((ref.content || "").slice(0, 700))}</div>
      </article>
    `;
  }).join("");
}

async function askCompare() {
  const question = els.questionInput.value.trim();
  if (!question) {
    els.notice.textContent = "请输入问题。";
    return;
  }

  setBusy(true);
  els.notice.textContent = els.refreshUrlsToggle.checked
    ? "正在刷新 URL 源并对比问答..."
    : "正在对比问答...";
  els.ragAnswer.textContent = "运行中...";
  els.directAnswer.textContent = "运行中...";
  els.references.innerHTML = "";

  try {
    await saveSelectedModel();
    const payload = await requestJson("/api/ask/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        refreshUrls: els.refreshUrlsToggle.checked
      })
    });

    els.ragMeta.textContent = `${payload.rag.model || "RAGFlow"} · ${payload.timings.ragMs}ms`;
    els.directMeta.textContent = `${payload.direct.model || "Direct"} · ${payload.timings.directMs}ms`;
    els.ragAnswer.textContent = payload.rag.error
      ? `RAGFlow 错误：${payload.rag.error}`
      : payload.rag.answer || "RAGFlow 没有返回答案。";
    els.directAnswer.textContent = payload.direct.error
      ? `直接模型错误：${payload.direct.error}`
      : payload.direct.answer || "直接模型没有返回答案。";
    renderReferences(payload.rag.references || []);
    els.notice.textContent = [
      payload.warnings?.length ? `刷新警告：${payload.warnings.length} 条` : "",
      payload.errors?.length ? `问答错误：${payload.errors.length} 条，详见两栏结果。` : "已保存到问答历史。"
    ].filter(Boolean).join("\n");
    await loadSources();
  } catch (error) {
    els.notice.textContent = `问答失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function logout() {
  await requestJson("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "./login.html";
}

els.uploadButton.addEventListener("click", uploadFiles);
els.urlButton.addEventListener("click", addUrls);
els.refreshSourcesButton.addEventListener("click", loadSources);
els.askButton.addEventListener("click", askCompare);
els.logoutButton.addEventListener("click", logout);

els.questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) askCompare();
});

["dragenter", "dragover"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("drag-over");
  });
});

els.dropZone.addEventListener("drop", (event) => {
  els.fileInput.files = event.dataTransfer.files;
});

createIcons();
Promise.all([loadSettings(), loadSources()]).catch((error) => {
  const base = window.ragKbApi.getBaseUrl();
  const pagesHint = location.hostname.endsWith("github.io") && !base
    ? "\n这是 GitHub Pages 静态前端，请先点“连接后端”，填写云服务器上的后端 API 地址。"
    : "";
  els.notice.textContent = `${error.message}${pagesHint}`;
});
