const express = require("express");
const router = express.Router();
const { register, login, updateProfile, changePassword } = require("../controllers/authController");
const { authenticate } = require("../middlewares/auth");

// Public routes
router.post("/register", register);
router.post("/login", login);

// Protected routes — require valid JWT
router.put("/profile", authenticate, updateProfile);
router.put("/change-password", authenticate, changePassword);

module.exports = router;
