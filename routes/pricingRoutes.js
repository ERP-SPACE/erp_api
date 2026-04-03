const express = require("express");
const router = express.Router();
const pricingController = require("../controllers/pricingController");
const { authenticate } = require("../middlewares/auth");

router.use(authenticate);

router.post("/calculate", pricingController.calculatePrice);
router.post("/override", pricingController.applyOverride);
router.get("/matrix/:customerId", pricingController.getPriceMatrix);
router.post("/deal-rate", pricingController.calculateDealRate);

router.post("/bulk-revision", pricingController.bulkRevision);

module.exports = router;
