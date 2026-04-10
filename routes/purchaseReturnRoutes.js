const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getPurchaseReturns,
  getPurchaseReturn,
  createPurchaseReturn,
  postPurchaseReturn,
  cancelPurchaseReturn,
} = require("../controllers/purchaseReturnController");

router.use(authenticate);

router.route("/").get(getPurchaseReturns).post(createPurchaseReturn);
router.route("/:id").get(getPurchaseReturn);
router.post("/:id/post", postPurchaseReturn);
router.post("/:id/cancel", cancelPurchaseReturn);

module.exports = router;

