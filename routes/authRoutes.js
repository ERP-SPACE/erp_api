const express = require("express");
const router = express.Router();
const {
  register,
  login,
  refreshSession,
  logout,
  updateProfile,
  changePassword,
} = require("../controllers/authController");
const { authenticate } = require("../middlewares/auth");

router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refreshSession);

router.post("/logout", authenticate, logout);
router.put("/profile", authenticate, updateProfile);
router.put("/change-password", authenticate, changePassword);

module.exports = router;
