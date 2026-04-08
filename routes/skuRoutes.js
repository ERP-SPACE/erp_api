const express = require("express");
const router = express.Router();
const skuController = require("../controllers/skuController");
// const { validateSKU } = require("../validators/skuValidator");
const { authenticate } = require("../middlewares/auth");

// All routes require authentication
router.use(authenticate);

router.get("/", skuController.getAllSKUs);
// Static routes MUST come before /:id — otherwise Express matches them as the id param
router.get("/available", skuController.getAvailableSKUs);
router.get("/code/:code", skuController.getSKUByCode);
router.get("/:id", skuController.getSKUById);

router.post("/", skuController.createSKU);
router.post("/bulk", skuController.bulkCreateSKUs);
router.patch("/:id", skuController.updateSKU);
router.patch("/:id/toggle-status", skuController.toggleSKUStatus);
router.delete("/:id", skuController.deleteSKU);

module.exports = router;
