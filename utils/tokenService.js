const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const UserSession = require("../models/UserSession");

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const REFRESH_TOKEN_TTL_DAYS = parseInt(
  process.env.JWT_REFRESH_TTL_DAYS || "30",
  10
);

const ensureJwtSecret = () => {
  if (!JWT_SECRET) {
    const error = new Error("Server misconfigured: JWT secret missing");
    error.statusCode = 500;
    throw error;
  }
};

const hashRefreshToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const generateRefreshToken = () => crypto.randomBytes(48).toString("hex");

const getRefreshExpiryDate = () => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);
  return expiresAt;
};

const signAccessToken = (user, sessionId) => {
  ensureJwtSecret();
  return jwt.sign(
    {
      userId: user._id,
      role: user.role,
      sessionId,
      type: "access",
    },
    JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    }
  );
};

const createSession = async (user, metadata = {}) => {
  const refreshToken = generateRefreshToken();
  const session = await UserSession.create({
    userId: user._id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: getRefreshExpiryDate(),
    userAgent: metadata.userAgent || "",
    ipAddress: metadata.ipAddress || "",
    lastUsedAt: new Date(),
  });

  return {
    accessToken: signAccessToken(user, session._id.toString()),
    refreshToken,
    session,
  };
};

const rotateSession = async (session, user) => {
  const refreshToken = generateRefreshToken();
  session.refreshTokenHash = hashRefreshToken(refreshToken);
  session.expiresAt = getRefreshExpiryDate();
  session.lastUsedAt = new Date();
  await session.save();

  return {
    accessToken: signAccessToken(user, session._id.toString()),
    refreshToken,
    session,
  };
};

const revokeSession = async (sessionId) => {
  if (!sessionId) return;
  await UserSession.findByIdAndUpdate(sessionId, {
    revokedAt: new Date(),
  });
};

const revokeAllUserSessions = async (userId) => {
  await UserSession.updateMany(
    { userId, revokedAt: null },
    { revokedAt: new Date() }
  );
};

const findActiveSessionByRefreshToken = async (refreshToken) => {
  if (!refreshToken) {
    return null;
  }

  return UserSession.findOne({
    refreshTokenHash: hashRefreshToken(refreshToken),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
};

module.exports = {
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_TTL_DAYS,
  createSession,
  ensureJwtSecret,
  findActiveSessionByRefreshToken,
  revokeAllUserSessions,
  revokeSession,
  rotateSession,
  signAccessToken,
};
