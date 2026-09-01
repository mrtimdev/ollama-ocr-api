import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function parseApiKeys(value = process.env.API_KEYS || "") {
  const entries = [];
  const trimmed = value.trim();
  if (!trimmed) return entries;

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Object.entries(parsed).map(([name, key]) => ({ name, digest: digest(key) }));
  }

  return trimmed.split(",").filter(Boolean).map((entry, index) => {
    const separator = entry.indexOf(":");
    const name = separator > 0 ? entry.slice(0, separator).trim() : `user-${ index + 1 }`;
    const key = separator > 0 ? entry.slice(separator + 1).trim() : entry.trim();
    return { name, digest: digest(key) };
  });
}

const configuredKeys = [
  ...parseApiKeys(),
  ...parseApiKeys(process.env.SPRING_API_KEYS || "spring:OPS_KEY"),
];

function readKey(request) {
  const authorization = request.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return request.get("x-api-key") || "";
}

function findUser(key) {
  if (!key) return null;
  const candidate = digest(key);
  const match = configuredKeys.find((entry) =>
    entry.digest.length === candidate.length && timingSafeEqual(entry.digest, candidate));
  return match ? { name: match.name, keyId: candidate.toString("hex").slice(0, 12) } : null;
}

function matchesKey(key, expected) {
  if (!key || !expected) return false;
  const candidate = digest(String(key).trim());
  const expectedDigest = digest(String(expected).trim());
  return candidate.length === expectedDigest.length && timingSafeEqual(candidate, expectedDigest);
}

function requireApiKey(request, response, next) {
  if (configuredKeys.length === 0) {
    return response.status(503).json({
      success: false,
      error: "No client API keys are configured. Set API_KEYS on the server.",
    });
  }

  const user = findUser(readKey(request));
  if (!user) {
    return response.status(401).json({
      success: false,
      error: "A valid API key is required in X-API-Key or Authorization: Bearer.",
    });
  }

  request.apiUser = user;
  next();
}

function isMonitorKeyValid(key) {
  return Boolean(authenticateMonitorKey(key));
}

function authenticateMonitorKey(key) {
  const monitorKey = process.env.MONITOR_API_KEY?.trim();
  const normalized = String(key || "").trim();
  if (!monitorKey && configuredKeys.length === 0) {
    return { scope: "monitor", user: null };
  }
  if (matchesKey(normalized, monitorKey)) {
    return { scope: "monitor", user: null };
  }
  const user = findUser(normalized);
  return user ? { scope: "user", user } : null;
}

function readMonitorKey(request) {
  const authorization = request.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.get("x-monitor-key")
    || request.get("x-api-key")
    || request.query?.monitorKey
    || request.query?.apiKey
    || "";
}

function requireMonitorKey(request, response, next) {
  const key = readMonitorKey(request);
  const access = authenticateMonitorKey(key);
  if (!access) {
    return response.status(401).json({
      success: false,
      error: "Invalid monitor key. Use MONITOR_API_KEY or a configured API/Spring key.",
    });
  }
  request.monitorAccess = access;
  next();
}

export {
  authenticateMonitorKey,
  configuredKeys,
  findUser,
  isMonitorKeyValid,
  parseApiKeys,
  readMonitorKey,
  requireApiKey,
  requireMonitorKey,
};
