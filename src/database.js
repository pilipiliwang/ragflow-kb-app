import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";
import initSqlJs from "sql.js";
import { decryptSecret, encryptSecret, randomId, safeJsonParse } from "./crypto.js";

const require = createRequire(import.meta.url);
const wasmPath = path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm"));

let sqlPromise;

function sqlRuntime() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(wasmPath, file)
    });
  }
  return sqlPromise;
}

const DEFAULT_SETTINGS = {
  ragflowBaseUrl: process.env.RAGFLOW_BASE_URL || "http://ragflow:9380",
  ragflowDatasetName: process.env.RAGFLOW_DATASET_NAME || "web-materials",
  ragflowDatasetId: "",
  ragflowChatName: process.env.RAGFLOW_CHAT_NAME || "web-materials-assistant",
  ragflowChatId: "",
  ragflowChatModel: "",
  directBaseUrl: process.env.DIRECT_AI_BASE_URL || "https://api.openai.com/v1",
  directModel: process.env.DIRECT_AI_MODEL || "",
  availableModels: process.env.DIRECT_AI_MODEL ? [process.env.DIRECT_AI_MODEL] : []
};

const SECRET_KEYS = new Set(["ragflowApiKey", "directApiKey", "externalApiKeys"]);

function nowIso() {
  return new Date().toISOString();
}

function rowObjects(statement) {
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function oneObject(statement) {
  const rows = rowObjects(statement);
  return rows[0] || null;
}

export async function createDatabase(filePath) {
  const SQL = await sqlRuntime();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let database;
  try {
    const file = await fs.readFile(filePath);
    database = new SQL.Database(new Uint8Array(file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    database = new SQL.Database();
  }

  const store = new AppDatabase(database, filePath);
  store.migrate();
  await store.bootstrapFromEnv();
  await store.save();
  return store;
}

export class AppDatabase {
  constructor(db, filePath) {
    this.db = db;
    this.filePath = filePath;
  }

  migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        secret INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        file_name TEXT,
        ragflow_dataset_id TEXT,
        ragflow_document_id TEXT,
        status TEXT NOT NULL,
        status_message TEXT,
        size INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        refreshed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_url ON sources(url) WHERE url IS NOT NULL AND url != '';

      CREATE TABLE IF NOT EXISTS qa_history (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        rag_answer TEXT,
        rag_references TEXT,
        direct_answer TEXT,
        rag_model TEXT,
        direct_model TEXT,
        warnings TEXT,
        errors TEXT,
        timings TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_qa_history_created_at ON qa_history(created_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        result TEXT,
        error TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
    `);
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const data = this.db.export();
    await fs.writeFile(this.filePath, Buffer.from(data));
  }

  async bootstrapFromEnv() {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (await this.getSettingRaw(key) === null) {
        this.setSettingValue(key, value);
      }
    }

    if (process.env.RAGFLOW_API_KEY && await this.getSettingRaw("ragflowApiKey") === null) {
      this.setSettingValue("ragflowApiKey", process.env.RAGFLOW_API_KEY, true);
    }
    if (process.env.DIRECT_AI_API_KEY && await this.getSettingRaw("directApiKey") === null) {
      this.setSettingValue("directApiKey", process.env.DIRECT_AI_API_KEY, true);
    }
    if (process.env.EXTERNAL_API_KEYS && await this.getSettingRaw("externalApiKeys") === null) {
      this.setSettingValue("externalApiKeys", process.env.EXTERNAL_API_KEYS, true);
    }
  }

  async getSettingRaw(key) {
    const statement = this.db.prepare("SELECT * FROM settings WHERE key = ?");
    statement.bind([key]);
    return oneObject(statement);
  }

  setSettingValue(key, value, secret = SECRET_KEYS.has(key)) {
    const encoded = secret
      ? encryptSecret(value)
      : JSON.stringify(value ?? "");
    this.db.run(
      `INSERT INTO settings (key, value, secret, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         secret = excluded.secret,
         updated_at = excluded.updated_at`,
      [key, encoded, secret ? 1 : 0, nowIso()]
    );
  }

  getSettings({ includeSecrets = false } = {}) {
    const rows = rowObjects(this.db.prepare("SELECT * FROM settings"));
    const settings = { ...DEFAULT_SETTINGS };
    const configuredSecrets = {};

    for (const row of rows) {
      if (row.secret) {
        configuredSecrets[row.key] = Boolean(row.value);
        if (includeSecrets) settings[row.key] = decryptSecret(row.value);
      } else {
        settings[row.key] = safeJsonParse(row.value, row.value);
      }
    }

    for (const key of SECRET_KEYS) {
      configuredSecrets[key] = configuredSecrets[key] || false;
      if (includeSecrets && !settings[key]) settings[key] = "";
    }

    if (!includeSecrets) settings.secrets = configuredSecrets;
    return settings;
  }

  updateSettings(payload) {
    const textKeys = [
      "ragflowBaseUrl",
      "ragflowDatasetName",
      "ragflowDatasetId",
      "ragflowChatName",
      "ragflowChatId",
      "ragflowChatModel",
      "directBaseUrl",
      "directModel"
    ];

    for (const key of textKeys) {
      if (Object.hasOwn(payload, key)) {
        this.setSettingValue(key, String(payload[key] || "").trim(), false);
      }
    }

    if (Object.hasOwn(payload, "availableModels")) {
      const models = Array.isArray(payload.availableModels)
        ? payload.availableModels
        : String(payload.availableModels || "").split(/[,\n]/);
      this.setSettingValue(
        "availableModels",
        models.map((item) => String(item).trim()).filter(Boolean),
        false
      );
    }

    for (const key of SECRET_KEYS) {
      if (String(payload[key] || "").trim()) {
        this.setSettingValue(key, String(payload[key]).trim(), true);
      }
      if (payload[`clear${key[0].toUpperCase()}${key.slice(1)}`]) {
        this.setSettingValue(key, "", true);
      }
    }
  }

  upsertSource(source) {
    const existing = source.id ? this.getSource(source.id) : null;
    const id = source.id || randomId("src");
    const createdAt = existing?.created_at || nowIso();
    const updatedAt = nowIso();
    this.db.run(
      `INSERT INTO sources (
        id, kind, title, url, file_name, ragflow_dataset_id, ragflow_document_id,
        status, status_message, size, content_hash, created_at, updated_at, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        url = excluded.url,
        file_name = excluded.file_name,
        ragflow_dataset_id = excluded.ragflow_dataset_id,
        ragflow_document_id = excluded.ragflow_document_id,
        status = excluded.status,
        status_message = excluded.status_message,
        size = excluded.size,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at,
        refreshed_at = excluded.refreshed_at`,
      [
        id,
        source.kind,
        source.title || source.fileName || source.url || "Untitled",
        source.url || "",
        source.fileName || "",
        source.ragflowDatasetId || "",
        source.ragflowDocumentId || "",
        source.status || "pending",
        source.statusMessage || "",
        source.size || 0,
        source.contentHash || "",
        createdAt,
        updatedAt,
        source.refreshedAt || null
      ]
    );
    return this.getSource(id);
  }

  getSource(id) {
    const statement = this.db.prepare("SELECT * FROM sources WHERE id = ?");
    statement.bind([id]);
    return oneObject(statement);
  }

  getSourceByUrl(url) {
    const statement = this.db.prepare("SELECT * FROM sources WHERE url = ?");
    statement.bind([url]);
    return oneObject(statement);
  }

  listSources() {
    return rowObjects(this.db.prepare("SELECT * FROM sources ORDER BY updated_at DESC"));
  }

  listUrlSources() {
    return rowObjects(this.db.prepare("SELECT * FROM sources WHERE kind = 'url' ORDER BY updated_at DESC"));
  }

  updateSourceStatus(id, fields) {
    const source = this.getSource(id);
    if (!source) return null;
    return this.upsertSource({
      id,
      kind: source.kind,
      title: fields.title ?? source.title,
      url: fields.url ?? source.url,
      fileName: fields.fileName ?? source.file_name,
      ragflowDatasetId: fields.ragflowDatasetId ?? source.ragflow_dataset_id,
      ragflowDocumentId: fields.ragflowDocumentId ?? source.ragflow_document_id,
      status: fields.status ?? source.status,
      statusMessage: fields.statusMessage ?? source.status_message,
      size: fields.size ?? source.size,
      contentHash: fields.contentHash ?? source.content_hash,
      refreshedAt: fields.refreshedAt ?? source.refreshed_at
    });
  }

  deleteSource(id) {
    this.db.run("DELETE FROM sources WHERE id = ?", [id]);
  }

  createJob(type, payload = {}) {
    const id = randomId("job");
    const timestamp = nowIso();
    this.db.run(
      `INSERT INTO jobs (
        id, type, status, payload, result, error, progress,
        created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        type,
        "queued",
        JSON.stringify(payload || {}),
        "",
        "",
        0,
        timestamp,
        timestamp,
        null,
        null
      ]
    );
    return this.getJob(id);
  }

  updateJob(id, fields = {}) {
    const current = this.getJob(id);
    if (!current) return null;
    const status = fields.status ?? current.status;
    const timestamp = nowIso();
    const result = Object.hasOwn(fields, "result")
      ? JSON.stringify(fields.result ?? null)
      : JSON.stringify(current.result ?? null);
    const payload = Object.hasOwn(fields, "payload")
      ? JSON.stringify(fields.payload ?? {})
      : JSON.stringify(current.payload ?? {});
    this.db.run(
      `UPDATE jobs SET
        status = ?,
        payload = ?,
        result = ?,
        error = ?,
        progress = ?,
        updated_at = ?,
        started_at = ?,
        finished_at = ?
       WHERE id = ?`,
      [
        status,
        payload,
        result,
        fields.error ?? current.error ?? "",
        fields.progress ?? current.progress ?? 0,
        timestamp,
        fields.startedAt ?? current.started_at ?? null,
        fields.finishedAt ?? current.finished_at ?? null,
        id
      ]
    );
    return this.getJob(id);
  }

  getJob(id) {
    const statement = this.db.prepare("SELECT * FROM jobs WHERE id = ?");
    statement.bind([id]);
    const job = oneObject(statement);
    return job ? this.parseJob(job) : null;
  }

  getNextQueuedJob() {
    return this.parseJob(oneObject(this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    )));
  }

  listJobs({ limit = 50, offset = 0, status = "" } = {}) {
    const args = [];
    const where = status ? "WHERE status = ?" : "";
    if (status) args.push(status);
    const countStatement = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs ${where}`);
    if (args.length) countStatement.bind(args);
    const count = oneObject(countStatement)?.count || 0;

    const statement = this.db.prepare(
      `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    );
    statement.bind([...args, limit, offset]);
    return {
      count,
      rows: rowObjects(statement).map((row) => this.parseJob(row))
    };
  }

  requeueInterruptedJobs() {
    this.db.run(
      `UPDATE jobs SET
        status = 'queued',
        error = '',
        updated_at = ?
       WHERE status = 'running'`,
      [nowIso()]
    );
  }

  parseJob(row) {
    if (!row) return null;
    return {
      ...row,
      payload: safeJsonParse(row.payload, {}),
      result: row.result ? safeJsonParse(row.result, null) : null
    };
  }

  addQaHistory(record) {
    const id = randomId("qa");
    this.db.run(
      `INSERT INTO qa_history (
        id, question, rag_answer, rag_references, direct_answer,
        rag_model, direct_model, warnings, errors, timings, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.question,
        record.ragAnswer || "",
        JSON.stringify(record.ragReferences || []),
        record.directAnswer || "",
        record.ragModel || "",
        record.directModel || "",
        JSON.stringify(record.warnings || []),
        JSON.stringify(record.errors || []),
        JSON.stringify(record.timings || {}),
        nowIso()
      ]
    );
    return id;
  }

  listQaHistory({ limit = 50, offset = 0 } = {}) {
    const count = oneObject(this.db.prepare("SELECT COUNT(*) AS count FROM qa_history"))?.count || 0;
    const statement = this.db.prepare(
      "SELECT * FROM qa_history ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );
    statement.bind([limit, offset]);
    const rows = rowObjects(statement).map((row) => ({
      ...row,
      rag_references: safeJsonParse(row.rag_references, []),
      warnings: safeJsonParse(row.warnings, []),
      errors: safeJsonParse(row.errors, []),
      timings: safeJsonParse(row.timings, {})
    }));
    return { count, rows };
  }
}
