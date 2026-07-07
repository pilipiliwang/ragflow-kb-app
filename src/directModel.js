function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function timeoutMs() {
  const value = Number(process.env.DIRECT_AI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

function normalizeApiKey(apiKey) {
  return String(apiKey || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function providerName(baseUrl) {
  const text = String(baseUrl || "").toLowerCase();
  if (text.includes("minimax")) return "MiniMax";
  if (text.includes("deepseek")) return "DeepSeek";
  if (text.includes("dashscope") || text.includes("aliyuncs")) return "通义千问";
  if (text.includes("openai")) return "OpenAI";
  return "直接模型";
}

function summarizeProviderError(status, text, baseUrl) {
  let message = text.slice(0, 500);
  try {
    const payload = JSON.parse(text);
    message = payload.error?.message || payload.message || payload.msg || message;
  } catch {
    // Keep raw text when the provider does not return JSON.
  }

  const provider = providerName(baseUrl);
  if (status === 401 || /invalid api key|unauthorized|authorized_error/i.test(message)) {
    return `${provider} API Key 无效或不属于当前 Base URL。请在对应模型平台重新复制 API Key，只填 key 本身，不要带 Bearer、引号或网页登录 token。供应商返回：${message}`;
  }
  return `${provider} HTTP ${status}: ${message}`;
}

export async function answerDirectly(settings, question, fetchImpl = fetch) {
  const baseUrl = normalizeBaseUrl(settings.directBaseUrl || "https://api.openai.com/v1");
  const apiKey = normalizeApiKey(settings.directApiKey);
  const model = settings.directModel;

  if (!apiKey) throw new Error("Direct model API key is not configured.");
  if (!model) throw new Error("Direct model is not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "You are a direct large-model assistant.",
              "Answer the user without using the private knowledge base.",
              "If the question is legal, tax, investment, or compliance related, avoid presenting the answer as formal advice."
            ].join("\n")
          },
          {
            role: "user",
            content: question
          }
        ]
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Direct model request timed out after ${timeoutMs()}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(summarizeProviderError(response.status, text, baseUrl));
  }

  const payload = JSON.parse(text);
  return {
    answer: payload.choices?.[0]?.message?.content?.trim() || "",
    model,
    usage: payload.usage || null
  };
}
