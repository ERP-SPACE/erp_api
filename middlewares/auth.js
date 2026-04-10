const jwt = require("jsonwebtoken");
const AppError = require("../utils/AppError");
const User = require("../models/User");
const UserSession = require("../models/UserSession");

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      throw new AppError("Please authenticate", 401);
    }

    if (!process.env.JWT_SECRET) {
      throw new AppError("Server misconfigured: JWT secret missing", 500);
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== "access" || !decoded.sessionId) {
      throw new AppError("Please authenticate", 401);
    }

    const user = await User.findById(decoded.userId).select(
      "role active passwordChangedAt"
    );
    if (!user || user.active === false) {
      throw new AppError("Please authenticate", 401);
    }

    if (decoded.iat && user.changedPasswordAfter(decoded.iat)) {
      throw new AppError("Please authenticate", 401);
    }

    const session = await UserSession.findOne({
      _id: decoded.sessionId,
      userId: decoded.userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).select("_id");

    if (!session) {
      throw new AppError("Please authenticate", 401);
    }

    req.userId = user._id.toString();
    req.userRole = user.role;
    req.user = user;
    req.sessionId = session._id.toString();

    next();
  } catch (error) {
    next(new AppError("Please authenticate", 401));
  }
};

const authorize = (roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return next(
        new AppError("You don't have permission to perform this action", 403)
      );
    }
    next();
  };
};

module.exports = { authenticate, authorize };
