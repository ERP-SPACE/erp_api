const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const { getPayments } = require("../controllers/paymentController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getPayments);

module.exports = router;
