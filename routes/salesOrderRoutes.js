const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getSalesOrders,
  getSalesOrder,
  createSalesOrder,
  updateSalesOrder,
  confirmSalesOrder,
  cancelSalesOrder,
  holdSalesOrder,
  closeSalesOrder,
  calculatePricing,
  previewAllocation,
} = require("../controllers/salesOrderController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getSalesOrders)
  .post(createSalesOrder);

// Static action routes BEFORE /:id to prevent "calculate-pricing" being matched as an id
router.post("/calculate-pricing", calculatePricing);
router.post("/preview-allocation", previewAllocation);

router.route("/:id")
  .get(getSalesOrder)
  .put(updateSalesOrder);

router.post("/:id/confirm", confirmSalesOrder);
router.post("/:id/cancel", cancelSalesOrder);
router.post("/:id/hold", holdSalesOrder);
router.post("/:id/close", closeSalesOrder);

module.exports = router;
