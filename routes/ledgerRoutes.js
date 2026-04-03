const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const { getLedgers } = require("../controllers/ledgerController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getLedgers);

module.exports = router;
