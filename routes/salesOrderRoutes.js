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
} = require("../controllers/salesOrderController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getSalesOrders)
  .post(createSalesOrder);

router.route("/:id")
  .get(getSalesOrder)
  .put(updateSalesOrder);

router.post("/:id/confirm", confirmSalesOrder);
router.post("/:id/cancel", cancelSalesOrder);
router.post("/:id/hold", holdSalesOrder);
router.post("/:id/close", closeSalesOrder);
router.post("/calculate-pricing", calculatePricing);

module.exports = router;
