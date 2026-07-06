(function () {
  const STORAGE_KEY = "ragKbApiBaseUrl";
  const API_KEY_STORAGE_KEY = "ragKbApiKey";

  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getApiBaseUrl() {
    const queryApi = new URLSearchParams(window.location.search).get("api");
    if (queryApi) {
      return setApiBaseUrl(queryApi);
    }
    return normalizeBaseUrl(
      localStorage.getItem(STORAGE_KEY) || window.RAG_KB_API_BASE_URL || ""
    );
  }

  function getApiKey() {
    const queryKey = new URLSearchParams(window.location.search).get("key");
    if (queryKey) {
      return setApiKey(queryKey);
    }
    return String(localStorage.getItem(API_KEY_STORAGE_KEY) || "").trim();
  }

  function setApiKey(value) {
    const normalized = String(value || "").trim();
    if (normalized) localStorage.setItem(API_KEY_STORAGE_KEY, normalized);
    else localStorage.removeItem(API_KEY_STORAGE_KEY);
    return normalized;
  }

  function setApiBaseUrl(value) {
    const normalized = normalizeBaseUrl(value);
    if (normalized) localStorage.setItem(STORAGE_KEY, normalized);
    else localStorage.removeItem(STORAGE_KEY);
    return normalized;
  }

  function buildUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    const base = getApiBaseUrl();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  async function apiFetch(path, options = {}) {
    const apiKey = getApiKey();
    return fetch(buildUrl(path), {
      ...options,
      credentials: "include",
      headers: {
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
        ...(options.headers || {})
      }
    });
  }

  async function apiJson(path, options = {}) {
    const response = await apiFetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  window.ragKbApi = {
    buildUrl,
    fetch: apiFetch,
    json: apiJson,
    getBaseUrl: getApiBaseUrl,
    setBaseUrl: setApiBaseUrl,
    getApiKey,
    setApiKey
  };
})();
