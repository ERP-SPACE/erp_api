const express = require("express");
const router = express.Router();
const { getVouchers } = require("../controllers/voucherController");
const { authenticate } = require("../middlewares/auth");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getVouchers);

module.exports = router;
