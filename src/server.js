import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { clearAccessCookie, hasAccess, requireExternalApiKey, requirePageAccess, setAccessCookie, verifyExternalApiKey, verifyInviteCode } from "./auth.js";
import { createDatabase } from "./database.js";
import { compareAnswers } from "./compareService.js";
import { randomId } from "./crypto.js";
import { JobRunner } from "./jobQueue.js";
import { RagflowClient, ensureRagflowResources } from "./ragflow.js";
import { importFileSource, refreshAllUrlSources, refreshUrlSource, removeSource } from "./sourceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataFile = path.resolve(rootDir, process.env.SQLITE_PATH || "./data/app.sqlite");
const uploadStagingDir = path.resolve(rootDir, process.env.UPLOAD_STAGING_PATH || "./data/pending-uploads");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  }
});

const db = await createDatabase(dataFile);

function parseUrls(payload = {}) {
  const rawUrls = Array.isArray(payload.urls)
    ? payload.urls
    : String(payload.urls || "").split(/\s+/);
  return rawUrls.map((url) => String(url).trim()).filter(Boolean);
}

function isAsyncRequest(req) {
  return req.query.async === "true" || req.body?.async === true || req.body?.async === "true";
}

async function importUploadedFiles(files) {
  const imported = [];
  for (const file of files) {
    try {
      imported.push(await importFileSource(db, file));
    } catch (error) {
      imported.push({
        file_name: file.originalname,
        status: "error",
        status_message: error.message
      });
    }
  }
  return imported;
}

async function stageUploadedFiles(files) {
  await fs.mkdir(uploadStagingDir, { recursive: true });
  const staged = [];
  for (const file of files) {
    const stagedName = `${randomId("upload")}-${path.basename(file.originalname || "file")}`;
    const stagedPath = path.join(uploadStagingDir, stagedName);
    await fs.writeFile(stagedPath, file.buffer);
    staged.push({
      path: stagedPath,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
  }
  return staged;
}

async function refreshUrls(urls) {
  const imported = [];
  for (const url of urls) {
    try {
      imported.push(await refreshUrlSource(db, url));
    } catch (error) {
      imported.push({
        url,
        status: "error",
        status_message: error.message
      });
    }
  }
  return imported;
}

async function healthPayload() {
  const settings = db.getSettings({ includeSecrets: true });
  let ragflow = { ok: false, error: "RAGFlow is not configured." };
  if (settings.ragflowBaseUrl && settings.ragflowApiKey) {
    try {
      ragflow = await new RagflowClient(settings).health();
    } catch (error) {
      ragflow = { ok: false, error: error.message };
    }
  }
  return {
    ok: true,
    sqlite: true,
    sources: db.listSources().length,
    qa: db.listQaHistory({ limit: 1, offset: 0 }).count,
    jobs: db.listJobs({ limit: 1, offset: 0 }).count,
    ragflow,
    settings: {
      ragflowApiKey: Boolean(settings.ragflowApiKey),
      directApiKey: Boolean(settings.directApiKey),
      externalApiKeys: Boolean(settings.externalApiKeys),
      directModel: Boolean(settings.directModel)
    }
  };
}

const jobRunner = new JobRunner(db, {
  import_files: async (payload, job) => {
    const files = Array.isArray(payload.files) ? payload.files : [];
    const imported = [];
    for (let index = 0; index < files.length; index += 1) {
      const staged = files[index];
      try {
        const buffer = await fs.readFile(staged.path);
        imported.push(await importFileSource(db, {
          buffer,
          originalname: staged.originalname,
          mimetype: staged.mimetype,
          size: staged.size
        }));
      } catch (error) {
        imported.push({
          file_name: staged.originalname,
          status: "error",
          status_message: error.message
        });
      } finally {
        await fs.unlink(staged.path).catch(() => {});
      }
      await job.updateProgress(Math.round(((index + 1) / Math.max(files.length, 1)) * 90), { imported });
    }
    return { imported, sources: db.listSources() };
  },
  refresh_urls: async (payload, job) => {
    const urls = parseUrls(payload);
    const imported = [];
    for (let index = 0; index < urls.length; index += 1) {
      const [item] = await refreshUrls([urls[index]]);
      imported.push(item);
      await job.updateProgress(Math.round(((index + 1) / Math.max(urls.length, 1)) * 90), { imported });
    }
    return { imported, sources: db.listSources() };
  },
  refresh_all_urls: async () => refreshAllUrlSources(db),
  ask_compare: async (payload) => compareAnswers(db, {
    question: String(payload.question || "").trim(),
    refreshUrls: Boolean(payload.refreshUrls)
  })
});

await jobRunner.start();

function corsOrigins() {
  return (process.env.CORS_ORIGINS || "http://localhost:4317,http://127.0.0.1:4317,https://pilipiliwang.github.io")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  const allowed = corsOrigins();
  return allowed.includes("*") || allowed.includes(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/", requirePageAccess, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/admin", requirePageAccess, (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.use(express.static(publicDir, { index: false }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/access", (req, res) => {
  const code = String(req.body.code || "").trim();
  if (!verifyInviteCode(code)) {
    return res.status(401).json({ error: "Invalid invite code." });
  }
  setAccessCookie(res, code);
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  clearAccessCookie(res);
  res.json({ ok: true });
});

function requireAccessOrApiKey(req, res, next) {
  if (hasAccess(req)) return next();
  const settings = db.getSettings({ includeSecrets: true });
  if (verifyExternalApiKey(req, settings)) return next();
  return res.status(401).json({ error: "Access code or API key required." });
}

const apiV1 = express.Router();
apiV1.use(requireExternalApiKey(db));

apiV1.get("/health", async (_req, res, next) => {
  try {
    res.json(await healthPayload());
  } catch (error) {
    next(error);
  }
});

apiV1.get("/sources", (_req, res) => {
  res.json({ sources: db.listSources() });
});

apiV1.post("/sources/upload", upload.array("files", 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Choose at least one file." });
    if (req.body?.async === false || req.body?.async === "false") {
      const imported = await importUploadedFiles(files);
      return res.json({ imported, sources: db.listSources() });
    }
    const job = await jobRunner.enqueue("import_files", {
      files: await stageUploadedFiles(files)
    });
    return res.status(202).json({ job, poll: `/api/v1/jobs/${job.id}` });
  } catch (error) {
    return next(error);
  }
});

apiV1.post("/sources/url", async (req, res, next) => {
  try {
    const urls = parseUrls(req.body || {});
    if (!urls.length) return res.status(400).json({ error: "Enter at least one URL." });
    if (req.body?.async === false || req.body?.async === "false") {
      const imported = await refreshUrls(urls);
      return res.json({ imported, sources: db.listSources() });
    }
    const job = await jobRunner.enqueue("refresh_urls", { urls });
    return res.status(202).json({ job, poll: `/api/v1/jobs/${job.id}` });
  } catch (error) {
    return next(error);
  }
});

apiV1.post("/sources/refresh-urls", async (_req, res, next) => {
  try {
    const job = await jobRunner.enqueue("refresh_all_urls", {});
    res.status(202).json({ job, poll: `/api/v1/jobs/${job.id}` });
  } catch (error) {
    next(error);
  }
});

apiV1.post("/ask", async (req, res, next) => {
  try {
    const question = String(req.body.question || "").trim();
    if (!question) return res.status(400).json({ error: "Enter a question." });
    if (isAsyncRequest(req)) {
      const job = await jobRunner.enqueue("ask_compare", {
        question,
        refreshUrls: Boolean(req.body.refreshUrls)
      });
      return res.status(202).json({ job, poll: `/api/v1/jobs/${job.id}` });
    }
    const result = await compareAnswers(db, {
      question,
      refreshUrls: Boolean(req.body.refreshUrls)
    });
    return res.json({
      id: result.id,
      question,
      answer: result.rag.answer,
      references: result.rag.references,
      model: result.rag.model,
      error: result.rag.error,
      warnings: result.warnings,
      timings: result.timings
    });
  } catch (error) {
    return next(error);
  }
});

apiV1.post("/ask/compare", async (req, res, next) => {
  try {
    const question = String(req.body.question || "").trim();
    if (!question) return res.status(400).json({ error: "Enter a question." });
    if (isAsyncRequest(req)) {
      const job = await jobRunner.enqueue("ask_compare", {
        question,
        refreshUrls: Boolean(req.body.refreshUrls)
      });
      return res.status(202).json({ job, poll: `/api/v1/jobs/${job.id}` });
    }
    return res.json(await compareAnswers(db, {
      question,
      refreshUrls: Boolean(req.body.refreshUrls)
    }));
  } catch (error) {
    return next(error);
  }
});

apiV1.get("/jobs/:id", (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  return res.json({ job });
});

app.use("/api/v1", apiV1);

app.use("/api", requireAccessOrApiKey);

app.get("/api/me", (req, res) => {
  res.json({ authenticated: hasAccess(req) });
});

app.get("/api/health", async (_req, res, next) => {
  try {
    res.json(await healthPayload());
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", (_req, res) => {
  res.json(db.getSettings({ includeSecrets: false }));
});

app.post("/api/settings", async (req, res, next) => {
  try {
    db.updateSettings(req.body || {});
    await db.save();
    res.json(db.getSettings({ includeSecrets: false }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/ragflow/ensure", async (_req, res, next) => {
  try {
    const settings = db.getSettings({ includeSecrets: true });
    const resources = await ensureRagflowResources(db, settings);
    await db.save();
    res.json({
      datasetId: resources.datasetId,
      chatId: resources.chatId,
      settings: db.getSettings({ includeSecrets: false })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/upload", upload.array("files", 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Choose at least one file." });

    if (isAsyncRequest(req)) {
      const job = await jobRunner.enqueue("import_files", {
        files: await stageUploadedFiles(files)
      });
      return res.status(202).json({ job, poll: `/api/jobs/${job.id}`, sources: db.listSources() });
    }

    const imported = await importUploadedFiles(files);
    res.json({ imported, sources: db.listSources() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/url", async (req, res, next) => {
  try {
    const urls = parseUrls(req.body || {});
    if (!urls.length) return res.status(400).json({ error: "Enter at least one URL." });

    if (isAsyncRequest(req)) {
      const job = await jobRunner.enqueue("refresh_urls", { urls });
      return res.status(202).json({ job, poll: `/api/jobs/${job.id}`, sources: db.listSources() });
    }

    const imported = await refreshUrls(urls);
    res.json({ imported, sources: db.listSources() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/refresh-urls", async (req, res, next) => {
  try {
    if (isAsyncRequest(req)) {
      const job = await jobRunner.enqueue("refresh_all_urls", {});
      return res.status(202).json({ job, poll: `/api/jobs/${job.id}`, sources: db.listSources() });
    }
    const result = await refreshAllUrlSources(db);
    return res.json({ ...result, sources: db.listSources() });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/admin/sources", (_req, res) => {
  res.json({ sources: db.listSources() });
});

app.delete("/api/admin/sources/:id", async (req, res, next) => {
  try {
    const removed = await removeSource(db, req.params.id);
    res.json({ removed, sources: db.listSources() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ask/compare", async (req, res, next) => {
  try {
    const question = String(req.body.question || "").trim();
    if (!question) return res.status(400).json({ error: "Enter a question." });
    if (isAsyncRequest(req)) {
      const job = await jobRunner.enqueue("ask_compare", {
        question,
        refreshUrls: Boolean(req.body.refreshUrls)
      });
      return res.status(202).json({ job, poll: `/api/jobs/${job.id}` });
    }
    const result = await compareAnswers(db, {
      question,
      refreshUrls: Boolean(req.body.refreshUrls)
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/admin/qa", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  res.json(db.listQaHistory({ limit, offset }));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  return res.json({ job });
});

app.get("/api/admin/jobs", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const status = String(req.query.status || "").trim();
  res.json(db.listJobs({ limit, offset, status }));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Server error." });
});

const port = Number(process.env.PORT || 4317);
app.listen(port, () => {
  console.log(`RAGFlow KB app running at http://localhost:${port}`);
});
