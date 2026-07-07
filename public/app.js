const state = {
  settings: null,
  sources: [],
  busy: false
};

const els = {
  statusText: document.querySelector("#statusText"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  filePreview: document.querySelector("#filePreview"),
  uploadButton: document.querySelector("#uploadButton"),
  urlInput: document.querySelector("#urlInput"),
  urlButton: document.querySelector("#urlButton"),
  refreshSourcesButton: document.querySelector("#refreshSourcesButton"),
  sourceList: document.querySelector("#sourceList"),
  logoutButton: document.querySelector("#logoutButton"),
  questionInput: document.querySelector("#questionInput"),
  modelSelect: document.querySelector("#modelSelect"),
  modelHint: document.querySelector("#modelHint"),
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

function repairMojibake(value) {
  const text = String(value ?? "");
  if (!/[\u0080-\u00ff]/.test(text)) return text;
  try {
    const bytes = new Uint8Array([...text].map((char) => char.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\u4e00-\u9fff]/.test(decoded) ? decoded : text;
  } catch {
    return text;
  }
}

function displayText(value) {
  return repairMojibake(value || "");
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

function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function statusClass(status) {
  if (status === "error") return "status-error";
  if (status === "parsing" || status === "refreshing") return "status-warn";
  return "status-ok";
}

function statusLabel(status) {
  if (status === "ready") return "可检索";
  if (status === "error") return "失败";
  if (status === "parsing") return "解析中";
  if (status === "refreshing") return "刷新中";
  if (status === "uploading") return "上传中";
  return status || "待处理";
}

function sourceUseLabel(status) {
  if (status === "ready") return "参与本次 RAG";
  if (status === "error") return "不参与 RAG";
  return "完成后参与 RAG";
}

function sourceKindLabel(kind) {
  return kind === "url" ? "网页" : "文件";
}

function renderSources() {
  const readyCount = state.sources.filter((source) => source.status === "ready").length;
  els.statusText.textContent = `${readyCount}/${state.sources.length} 个可检索`;
  if (!state.sources.length) {
    els.sourceList.innerHTML = `<div class="empty">暂无资料源。上传文件或粘贴 URL 后，这里会显示当前知识库中可用于 RAG 的材料。</div>`;
    return;
  }

  els.sourceList.innerHTML = state.sources.map((source) => {
    const title = displayText(source.title || source.url || source.file_name || "未命名资料");
    const message = displayText(source.status_message || "");
    return `
      <article class="source-item">
        <div class="source-main">
          <div>
            <div class="source-title">${escapeHtml(title)}</div>
            <div class="meta-row">
              <span>${sourceKindLabel(source.kind)}</span>
              <span class="${statusClass(source.status)}">${statusLabel(source.status)}</span>
              <span>${sourceUseLabel(source.status)}</span>
              <span>${formatDate(source.refreshed_at || source.updated_at)}</span>
              ${source.size ? `<span>${formatBytes(source.size)}</span>` : ""}
            </div>
          </div>
          <button class="icon-button source-delete" type="button" data-delete-source="${escapeHtml(source.id)}" title="删除资料源">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
        ${message ? `<small>${escapeHtml(message)}</small>` : ""}
      </article>
    `;
  }).join("");
  createIcons();
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
  const configured = state.settings?.secrets?.directApiKey && state.settings?.directModel;
  els.modelHint.innerHTML = configured
    ? `直接模型已配置：${escapeHtml(state.settings.directModel)}`
    : `未配置直接大模型。RAGFlow 左栏仍可用；右栏需要到 <a href="./admin.html">后台</a> 填 Direct AI API Key 和 Direct Model。`;
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

function renderSelectedFiles() {
  const files = [...els.fileInput.files];
  if (!files.length) {
    els.filePreview.className = "file-preview empty compact-empty";
    els.filePreview.textContent = "尚未选择文件。";
    return;
  }

  els.filePreview.className = "file-preview";
  els.filePreview.innerHTML = `
    <div class="file-preview-head">待上传 ${files.length} 个文件</div>
    ${files.map((file) => `
      <div class="file-preview-row">
        <span>${escapeHtml(displayText(file.name))}</span>
        <small>${formatBytes(file.size)}</small>
      </div>
    `).join("")}
  `;
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
    els.notice.textContent = summarizeImport(payload.imported || [], "文件");
    els.fileInput.value = "";
    renderSelectedFiles();
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
    els.notice.textContent = "没有粘贴 URL，不会导入网页。";
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
    els.notice.textContent = summarizeImport(payload.imported || [], "URL");
    els.urlInput.value = "";
    await loadSources();
  } catch (error) {
    els.notice.textContent = `URL 导入失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function deleteSource(sourceId) {
  if (!sourceId) return;
  setBusy(true);
  els.notice.textContent = "正在删除资料源...";
  try {
    const payload = await requestJson(`/api/admin/sources/${encodeURIComponent(sourceId)}`, {
      method: "DELETE"
    });
    state.sources = payload.sources || [];
    renderSources();
    els.notice.textContent = "已从当前知识库删除该资料源。";
  } catch (error) {
    els.notice.textContent = `删除失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

function summarizeImport(items, label = "资料") {
  if (!items.length) return `没有导入${label}。`;
  const ready = items.filter((item) => item.status === "ready").length;
  const parsing = items.filter((item) => item.status === "parsing").length;
  const failed = items.filter((item) => item.status === "error").length;
  const lines = [`已提交 ${items.length} 个${label}：${ready} 个可检索，${parsing} 个解析中，${failed} 个失败。`];
  lines.push(...items.map((item, index) => {
    const name = displayText(item.title || item.url || item.file_name || item.fileName || "未命名资料");
    const message = displayText(item.status_message || "");
    return `${index + 1}. ${name}：${statusLabel(item.status)}${message ? `，${message}` : ""}`;
  }));
  return lines.join("\n");
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

  els.references.innerHTML = references.slice(0, 5).map((ref, index) => {
    const title = displayText(ref.documentName || ref.documentId || `来源 ${index + 1}`);
    const excerpt = displayText(ref.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const heading = ref.url
      ? `<a href="${escapeHtml(ref.url)}" target="_blank" rel="noreferrer">来源 ${index + 1} · ${escapeHtml(title)}</a>`
      : `<strong>来源 ${index + 1} · ${escapeHtml(title)}</strong>`;
    return `
      <article class="reference-item">
        <div class="reference-title">${heading}</div>
        ${excerpt ? `<div class="reference-excerpt">${escapeHtml(excerpt)}${excerpt.length >= 180 ? "..." : ""}</div>` : ""}
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
els.fileInput.addEventListener("change", renderSelectedFiles);
els.sourceList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-source]");
  if (button) deleteSource(button.dataset.deleteSource);
});

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
  renderSelectedFiles();
});

createIcons();
renderSelectedFiles();
Promise.all([loadSettings(), loadSources()]).catch((error) => {
  const base = window.ragKbApi.getBaseUrl();
  const pagesHint = location.hostname.endsWith("github.io") && !base
    ? "\n这是 GitHub Pages 静态前端，请先点“连接后端”，填写云服务器上的后端 API 地址。"
    : "";
  els.notice.textContent = `${error.message}${pagesHint}`;
});
