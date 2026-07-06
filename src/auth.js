import crypto from "crypto";
import { hashValue } from "./crypto.js";

const COOKIE_NAME = "rag_kb_access";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function inviteCodes() {
  const raw = process.env.APP_INVITE_CODES || "dev-invite";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function signingSecret() {
  return process.env.APP_SECRET || "local-dev-secret-change-me";
}

function sign(value) {
  return crypto
    .createHmac("sha256", signingSecret())
    .update(value)
    .digest("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, index)),
          decodeURIComponent(part.slice(index + 1))
        ];
      })
  );
}

function configuredApiKeys(settings = {}) {
  const values = [
    settings.externalApiKeys,
    process.env.EXTERNAL_API_KEYS
  ].filter(Boolean);

  return values
    .flatMap((value) => String(value).split(/[,\n]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractApiKey(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const xApiKey = String(req.headers["x-api-key"] || "").trim();
  return bearer || xApiKey;
}

export function verifyInviteCode(code) {
  const normalized = String(code || "").trim();
  return normalized && inviteCodes().includes(normalized);
}

export function verifyExternalApiKey(req, settings = {}) {
  const provided = extractApiKey(req);
  if (!provided) return false;
  const providedHash = hashValue(provided);
  return configuredApiKeys(settings).some((key) => hashValue(key) === providedHash);
}

export function createAccessCookie(code) {
  const payload = {
    codeHash: hashValue(String(code || "").trim()),
    exp: Date.now() + MAX_AGE_SECONDS * 1000
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function hasAccess(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies[COOKIE_NAME];
  if (!value) return false;
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature || sign(encoded) !== signature) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  if (!payload?.exp || payload.exp < Date.now()) return false;
  const allowedHashes = inviteCodes().map((code) => hashValue(code));
  return allowedHashes.includes(payload.codeHash);
}

export function setAccessCookie(res, code) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  const sameSite = process.env.COOKIE_SAMESITE || "Lax";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(createAccessCookie(code))}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${MAX_AGE_SECONDS}${secure}`
  );
}

export function clearAccessCookie(res) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  const sameSite = process.env.COOKIE_SAMESITE || "Lax";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`
  );
}

export function requireAccess(req, res, next) {
  if (hasAccess(req)) return next();
  return res.status(401).json({ error: "Access code required." });
}

export function requirePageAccess(req, res, next) {
  if (hasAccess(req)) return next();
  return res.redirect("/login");
}

export function requireExternalApiKey(db) {
  return (req, res, next) => {
    const settings = db.getSettings({ includeSecrets: true });
    if (verifyExternalApiKey(req, settings)) return next();
    return res.status(401).json({ error: "Valid API key required." });
  };
}
