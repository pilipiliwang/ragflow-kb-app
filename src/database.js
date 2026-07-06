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

const SECRET_KEYS = new Set(["ragflowApiKey", "directApiKey"]);

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
