const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getSalesReturns,
  getSalesReturn,
  createSalesReturn,
  postSalesReturn,
  cancelSalesReturn,
} = require("../controllers/salesReturnController");

router.use(authenticate);

router.route("/").get(getSalesReturns).post(createSalesReturn);
router.route("/:id").get(getSalesReturn);
router.post("/:id/post", postSalesReturn);
router.post("/:id/cancel", cancelSalesReturn);

module.exports = router;

