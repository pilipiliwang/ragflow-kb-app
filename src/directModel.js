function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export async function answerDirectly(settings, question, fetchImpl = fetch) {
  const baseUrl = normalizeBaseUrl(settings.directBaseUrl || "https://api.openai.com/v1");
  const apiKey = settings.directApiKey;
  const model = settings.directModel;

  if (!apiKey) throw new Error("Direct model API key is not configured.");
  if (!model) throw new Error("Direct model is not configured.");

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
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

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Direct model HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = JSON.parse(text);
  return {
    answer: payload.choices?.[0]?.message?.content?.trim() || "",
    model,
    usage: payload.usage || null
  };
}
