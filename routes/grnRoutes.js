const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getGRNs,
  getGRN,
  createGRN,
  postGRN,
} = require("../controllers/grnController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getGRNs)
  .post(createGRN);

router.route("/:id")
  .get(getGRN);

router.post("/:id/post", postGRN);

module.exports = router;
