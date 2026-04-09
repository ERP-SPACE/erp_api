const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const signToken = (user) =>
  jwt.sign(
    {
      userId: user._id,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );

const sanitizeUser = (user) => {
  const obj = user.toObject({ versionKey: false });
  delete obj.password;
  return obj;
};

// Register new user (default SalesExec) — requires full address per model
const register = handleAsyncErrors(async (req, res) => {
  if (!JWT_SECRET) {
    throw new AppError("Server misconfigured: JWT secret missing", 500);
  }

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

  // Never allow clients to self-assign privileged roles
  const role = "SalesExec";

  const addressPayload = {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    pincode: address.pincode,
  };

  if (!addressPayload.line1 || !addressPayload.city || !addressPayload.pincode) {
    throw new AppError(
      "Address line1, city and pincode are required",
      400
    );
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

  const token = signToken(user);

  res.status(201).json({
    success: true,
    token,
    user: sanitizeUser(user),
  });
});

// Login with username or email
const login = handleAsyncErrors(async (req, res) => {
  if (!JWT_SECRET) {
    throw new AppError("Server misconfigured: JWT secret missing", 500);
  }

  const { identifier, password } = req.body;

  if (!identifier || !password) {
    throw new AppError("Identifier and password are required", 400);
  }

  const user = await User.findOne({
    $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
  }).select("+password");

  if (!user || !(await user.correctPassword(password))) {
    throw new AppError("Invalid credentials", 401);
  }

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  const token = signToken(user);

  res.json({
    success: true,
    token,
    user: sanitizeUser(user),
  });
});

// Update logged-in user's profile (username, email, phone)
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

// Change password for the logged-in user
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

  res.json({
    success: true,
    message: "Password changed successfully",
  });
});

module.exports = {
  register,
  login,
  updateProfile,
  changePassword,
};
