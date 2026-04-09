const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getBatches,
  getBatch,
  createBatch,
} = require("../controllers/batchController");

router.use(authenticate);

router.route("/")
  .get(getBatches)
  .post(createBatch);

router.route("/:id")
  .get(getBatch);

module.exports = router;
