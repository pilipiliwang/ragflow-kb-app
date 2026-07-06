const codeInput = document.querySelector("#codeInput");
const apiBaseInput = document.querySelector("#apiBaseInput");
const apiKeyInput = document.querySelector("#apiKeyInput");
const loginButton = document.querySelector("#loginButton");
const loginMessage = document.querySelector("#loginMessage");

function createIcons() {
  if (window.lucide) window.lucide.createIcons();
}

async function login() {
  window.ragKbApi.setBaseUrl(apiBaseInput.value);
  window.ragKbApi.setApiKey(apiKeyInput.value);
  const code = codeInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  if (!code && !apiKey) {
    loginMessage.textContent = "请输入邀请码或外部 API Key。";
    return;
  }
  loginButton.disabled = true;
  loginMessage.textContent = "正在验证...";
  try {
    if (code) {
      const response = await window.ragKbApi.fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    } else {
      await window.ragKbApi.json("/api/health");
    }
    window.location.href = "./index.html";
  } catch (error) {
    loginMessage.textContent = `验证失败：${error.message}`;
  } finally {
    loginButton.disabled = false;
  }
}

loginButton.addEventListener("click", login);
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
apiBaseInput.value = window.ragKbApi.getBaseUrl();
apiKeyInput.value = window.ragKbApi.getApiKey();
createIcons();
