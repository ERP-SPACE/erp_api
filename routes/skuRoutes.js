const express = require("express");
const router = express.Router();
const skuController = require("../controllers/skuController");
// const { validateSKU } = require("../validators/skuValidator");
const { authenticate } = require("../middlewares/auth");

// All routes require authentication
router.use(authenticate);

router.get("/", skuController.getAllSKUs);
router.get("/available", skuController.getAvailableSKUs);
router.get("/:id", skuController.getSKUById);
router.get("/code/:code", skuController.getSKUByCode);

router.post("/", skuController.createSKU);
router.post("/bulk", skuController.bulkCreateSKUs);
router.patch("/:id", skuController.updateSKU);
router.patch("/:id/toggle-status", skuController.toggleSKUStatus);
router.delete("/:id", skuController.deleteSKU);

module.exports = router;
