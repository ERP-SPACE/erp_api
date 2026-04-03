const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getPurchaseInvoices,
  getPurchaseInvoice,
  createPurchaseInvoice,
  allocateLandedCost,
  postPurchaseInvoice,
} = require("../controllers/purchaseInvoiceController");

// All routes require authentication
router.use(authenticate);

router.route("/")
  .get(getPurchaseInvoices)
  .post(createPurchaseInvoice);

router.route("/:id")
  .get(getPurchaseInvoice);

router.post("/:id/allocate-landed-cost", allocateLandedCost);
router.post("/:id/post", postPurchaseInvoice);

module.exports = router;
