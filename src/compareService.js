import { performance } from "node:perf_hooks";
import { answerDirectly } from "./directModel.js";
import { ensureRagflowResources } from "./ragflow.js";
import { refreshAllUrlSources } from "./sourceService.js";

async function timed(label, fn) {
  const started = performance.now();
  try {
    const value = await fn();
    return {
      status: "fulfilled",
      value,
      ms: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      status: "rejected",
      error,
      ms: Math.round(performance.now() - started)
    };
  }
}

export async function compareAnswers(db, { question, refreshUrls = false }) {
  const warnings = [];
  if (refreshUrls) {
    const refreshResult = await refreshAllUrlSources(db);
    warnings.push(...refreshResult.warnings);
  }

  const settings = db.getSettings({ includeSecrets: true });

  const ragTask = timed("rag", async () => {
    const resources = await ensureRagflowResources(db, settings);
    await db.save();
    return resources.client.chat({
      chatId: resources.chatId,
      question,
      model: settings.ragflowChatModel
    });
  });

  const directTask = timed("direct", () => answerDirectly(settings, question));
  const [rag, direct] = await Promise.all([ragTask, directTask]);
  const errors = [];

  const ragAnswer = rag.status === "fulfilled" ? rag.value.answer : "";
  const ragReferences = rag.status === "fulfilled" ? rag.value.references : [];
  if (rag.status === "rejected") errors.push({ channel: "rag", error: rag.error.message });

  const directAnswer = direct.status === "fulfilled" ? direct.value.answer : "";
  if (direct.status === "rejected") errors.push({ channel: "direct", error: direct.error.message });

  const timings = {
    ragMs: rag.ms,
    directMs: direct.ms
  };

  const historyId = db.addQaHistory({
    question,
    ragAnswer,
    ragReferences,
    directAnswer,
    ragModel: settings.ragflowChatModel || "RAGFlow assistant default",
    directModel: settings.directModel,
    warnings,
    errors,
    timings
  });
  await db.save();

  return {
    id: historyId,
    question,
    rag: {
      answer: ragAnswer,
      references: ragReferences,
      model: settings.ragflowChatModel || "RAGFlow assistant default",
      error: rag.status === "rejected" ? rag.error.message : ""
    },
    direct: {
      answer: directAnswer,
      model: settings.directModel,
      error: direct.status === "rejected" ? direct.error.message : ""
    },
    warnings,
    errors,
    timings
  };
}
