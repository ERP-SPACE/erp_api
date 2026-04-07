const express = require("express");
const router = express.Router();
const customerController = require("../controllers/customerController");
const { authenticate } = require("../middlewares/auth");

router.use(authenticate);

router.get("/", customerController.getCustomers);
router.get("/:id", customerController.getCustomer);
router.get("/:id/credit-check", customerController.checkCredit);
router.get("/:id/rate-history", customerController.getRateHistory);
router.get("/:id/rates", customerController.getCustomerRates);

router.post("/", customerController.createCustomer);
router.post("/:id/rates", customerController.setCustomerRate);
router.post("/:id/block", customerController.blockCustomer);
router.post("/:id/unblock", customerController.unblockCustomer);

router.patch("/:id", customerController.updateCustomer);

router.delete("/:id/rates/:skuId", customerController.deleteCustomerRate);
router.delete("/:id", customerController.deleteCustomer);

module.exports = router;
