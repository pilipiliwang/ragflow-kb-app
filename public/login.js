const codeInput = document.querySelector("#codeInput");
const loginButton = document.querySelector("#loginButton");
const loginMessage = document.querySelector("#loginMessage");

function createIcons() {
  if (window.lucide) window.lucide.createIcons();
}

async function login() {
  const code = codeInput.value.trim();
  if (!code) {
    loginMessage.textContent = "请输入邀请码。";
    return;
  }
  loginButton.disabled = true;
  loginMessage.textContent = "正在验证...";
  try {
    const response = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    window.location.href = "/";
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
createIcons();
