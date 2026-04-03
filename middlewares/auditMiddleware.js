const AuditLog = require("../models/AuditLog");

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "authorization",
  "refreshToken",
  "accessToken",
  "jwt",
  "secret",
  "apiKey",
  "otp",
  "pin",
]);

const redactSensitive = (value, depth = 0) => {
  if (depth > 6) return "[Truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSensitive(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(String(k))) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSensitive(v, depth + 1);
    }
  }
  return out;
};

const auditMiddleware = async (req, res, next) => {
  // Store original send function
  const originalSend = res.send;

  // Store request start time
  req.startTime = Date.now();

  // Override send function to capture response
  res.send = function (data) {
    res.responseBody = data;
    originalSend.call(this, data);
  };

  // Continue with request
  res.on("finish", async () => {
    // Only log for modification operations
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      res.statusCode < 400
    ) {
      try {
        const auditEntry = {
          userId: req.userId || "anonymous",
          action: getActionFromMethod(req.method),
          entity: getEntityFromPath(req.path),
          entityId: req.params.id || null,
          changes: {
            before: req.body?.before ? redactSensitive(req.body.before) : null,
            after: redactSensitive(req.body),
          },
          ipAddress: req.ip,
          timestamp: new Date(),
        };

        await AuditLog.create(auditEntry);
      } catch (error) {
        console.error("Audit log error:", error);
      }
    }
  });

  next();
};

const getActionFromMethod = (method) => {
  const actionMap = {
    POST: "Create",
    PUT: "Update",
    PATCH: "Update",
    DELETE: "Delete",
  };
  return actionMap[method] || "Unknown";
};

const getEntityFromPath = (path) => {
  const pathParts = path.split("/").filter(Boolean);
  if (pathParts.length >= 3) {
    return pathParts[2]; // /api/v1/[entity]
  }
  return "Unknown";
};

module.exports = auditMiddleware;
