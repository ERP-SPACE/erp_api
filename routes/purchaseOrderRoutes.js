const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  approvePurchaseOrder,
  closePurchaseOrder,
  cancelPurchaseOrder,
  remindPurchaseOrder,
} = require("../controllers/purchaseOrderController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getPurchaseOrders)
  .post(createPurchaseOrder);

router.route("/:id")
  .get(getPurchaseOrder)
  .put(updatePurchaseOrder);

router.post("/:id/approve", approvePurchaseOrder);
router.post("/:id/close", closePurchaseOrder);
router.post("/:id/cancel", cancelPurchaseOrder);
router.post("/:id/remind", remindPurchaseOrder);

module.exports = router;
