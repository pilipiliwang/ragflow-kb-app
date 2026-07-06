import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function secretKey() {
  const secret = process.env.APP_SECRET || "local-dev-secret-change-me";
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function encryptSecret(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(":");
}

export function decryptSecret(value) {
  if (!value) return "";
  const [version, ivText, tagText, ciphertextText] = String(value).split(":");
  if (version !== VERSION || !ivText || !tagText || !ciphertextText) {
    return "";
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    secretKey(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

export function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
