import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { clearAccessCookie, hasAccess, requireAccess, requirePageAccess, setAccessCookie, verifyInviteCode } from "./auth.js";
import { createDatabase } from "./database.js";
import { compareAnswers } from "./compareService.js";
import { RagflowClient, ensureRagflowResources } from "./ragflow.js";
import { importFileSource, refreshAllUrlSources, refreshUrlSource, removeSource } from "./sourceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataFile = path.resolve(rootDir, process.env.SQLITE_PATH || "./data/app.sqlite");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  }
});

const db = await createDatabase(dataFile);

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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

app.use("/api", requireAccess);

app.get("/api/me", (req, res) => {
  res.json({ authenticated: hasAccess(req) });
});

app.get("/api/health", async (_req, res) => {
  const settings = db.getSettings({ includeSecrets: true });
  let ragflow = { ok: false, error: "RAGFlow is not configured." };
  if (settings.ragflowBaseUrl && settings.ragflowApiKey) {
    try {
      ragflow = await new RagflowClient(settings).health();
    } catch (error) {
      ragflow = { ok: false, error: error.message };
    }
  }
  res.json({
    ok: true,
    sqlite: true,
    sources: db.listSources().length,
    qa: db.listQaHistory({ limit: 1, offset: 0 }).count,
    ragflow,
    settings: {
      ragflowApiKey: Boolean(settings.ragflowApiKey),
      directApiKey: Boolean(settings.directApiKey),
      directModel: Boolean(settings.directModel)
    }
  });
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

    res.json({ imported, sources: db.listSources() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/url", async (req, res, next) => {
  try {
    const rawUrls = Array.isArray(req.body.urls)
      ? req.body.urls
      : String(req.body.urls || "").split(/\s+/);
    const urls = rawUrls.map((url) => String(url).trim()).filter(Boolean);
    if (!urls.length) return res.status(400).json({ error: "Enter at least one URL." });

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

    res.json({ imported, sources: db.listSources() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/refresh-urls", async (_req, res, next) => {
  try {
    const result = await refreshAllUrlSources(db);
    res.json({ ...result, sources: db.listSources() });
  } catch (error) {
    next(error);
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
    const result = await compareAnswers(db, {
      question,
      refreshUrls: Boolean(req.body.refreshUrls)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/qa", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  res.json(db.listQaHistory({ limit, offset }));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Server error." });
});

const port = Number(process.env.PORT || 4317);
app.listen(port, () => {
  console.log(`RAGFlow KB app running at http://localhost:${port}`);
});
