const User = require("../models/User");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");
const {
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_TTL_DAYS,
  createSession,
  ensureJwtSecret,
  findActiveSessionByRefreshToken,
  revokeAllUserSessions,
  revokeSession,
  rotateSession,
} = require("../utils/tokenService");

const sanitizeUser = (user) => {
  const obj = user.toObject({ versionKey: false });
  delete obj.password;
  return obj;
};

const getRequestMetadata = (req) => ({
  userAgent: req.get("user-agent") || "",
  ipAddress: req.ip || req.headers["x-forwarded-for"] || "",
});

const buildAuthResponse = (user, authResult) => ({
  success: true,
  token: authResult.accessToken,
  accessToken: authResult.accessToken,
  refreshToken: authResult.refreshToken,
  accessTokenExpiresIn: ACCESS_TOKEN_EXPIRES_IN,
  refreshTokenTtlDays: REFRESH_TOKEN_TTL_DAYS,
  sessionId: authResult.session._id,
  user: sanitizeUser(user),
});

// Register new user (default SalesExec) â€” requires full address per model
const register = handleAsyncErrors(async (req, res) => {
  ensureJwtSecret();

  const explicitAllow =
    (process.env.ALLOW_PUBLIC_REGISTRATION || "").toLowerCase() === "true";
  const allowPublicRegistration =
    process.env.NODE_ENV !== "production" || explicitAllow;
  if (!allowPublicRegistration) {
    throw new AppError("Registration is disabled", 403);
  }

  const {
    username,
    email,
    password,
    address = {},
    state,
    country,
  } = req.body;

  if (!username || !email || !password) {
    throw new AppError("Username, email and password are required", 400);
  }

  const role = "SalesExec";

  const addressPayload = {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    pincode: address.pincode,
  };

  if (!addressPayload.line1 || !addressPayload.city || !addressPayload.pincode) {
    throw new AppError("Address line1, city and pincode are required", 400);
  }

  if (!state || !country) {
    throw new AppError("State and country are required", 400);
  }

  const user = await User.create({
    username,
    email,
    password,
    role,
    address: addressPayload,
    state,
    country,
  });

  const authResult = await createSession(user, getRequestMetadata(req));

  res.status(201).json(buildAuthResponse(user, authResult));
});

// Login with username or email
const login = handleAsyncErrors(async (req, res) => {
  ensureJwtSecret();

  const { identifier, password } = req.body;

  if (!identifier || !password) {
    throw new AppError("Identifier and password are required", 400);
  }

  const user = await User.findOne({
    $or: [
      { email: identifier.toLowerCase() },
      { username: identifier.toLowerCase() },
    ],
  }).select("+password");

  if (!user || !(await user.correctPassword(password))) {
    throw new AppError("Invalid credentials", 401);
  }

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  const authResult = await createSession(user, getRequestMetadata(req));

  res.json(buildAuthResponse(user, authResult));
});

const refreshSession = handleAsyncErrors(async (req, res) => {
  ensureJwtSecret();

  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    throw new AppError("Refresh token is required", 400, "VALIDATION_ERROR");
  }

  const session = await findActiveSessionByRefreshToken(refreshToken);
  if (!session) {
    throw new AppError("Invalid session", 401, "INVALID_SESSION");
  }

  const user = await User.findById(session.userId);
  if (!user || user.active === false) {
    await revokeSession(session._id);
    throw new AppError("Invalid session", 401, "INVALID_SESSION");
  }

  const authResult = await rotateSession(session, user);
  res.json(buildAuthResponse(user, authResult));
});

const logout = handleAsyncErrors(async (req, res) => {
  const { refreshToken } = req.body || {};

  if (req.sessionId) {
    await revokeSession(req.sessionId);
  } else if (refreshToken) {
    const session = await findActiveSessionByRefreshToken(refreshToken);
    if (session) {
      await revokeSession(session._id);
    }
  }

  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

const updateProfile = handleAsyncErrors(async (req, res) => {
  const ALLOWED_FIELDS = ["username", "email", "phone"];
  const updates = {};
  for (const field of ALLOWED_FIELDS) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided to update", 400);
  }

  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (!user) {
    throw new AppError("User not found", 404);
  }

  res.json({
    success: true,
    user: sanitizeUser(user),
  });
});

const changePassword = handleAsyncErrors(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new AppError("Current password and new password are required", 400);
  }

  if (newPassword.length < 8) {
    throw new AppError("New password must be at least 8 characters long", 400);
  }

  const user = await User.findById(req.userId).select("+password");
  if (!user) {
    throw new AppError("User not found", 404);
  }

  const isCorrect = await user.correctPassword(currentPassword);
  if (!isCorrect) {
    throw new AppError("Current password is incorrect", 401);
  }

  user.password = newPassword;
  await user.save();
  await revokeAllUserSessions(user._id);

  res.json({
    success: true,
    message: "Password changed successfully",
  });
});

module.exports = {
  register,
  login,
  refreshSession,
  logout,
  updateProfile,
  changePassword,
};
