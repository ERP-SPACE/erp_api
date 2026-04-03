const express = require("express");
const router = express.Router();
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");
const { authenticate } = require("../middlewares/auth");

// Placeholder controller - will be implemented later
const getBatches = handleAsyncErrors(async (req, res) => {
  res.json({
    success: true,
    data: [],
    message: "Batch module - implementation pending",
  });
});

router.use(authenticate);

router.route("/")
  .get(getBatches);

module.exports = router;
