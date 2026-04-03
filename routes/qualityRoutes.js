const express = require("express");
const router = express.Router();
const qualityController = require("../controllers/qualityController");
const { validateQuality } = require("../validators/qualityValidator");
const { authenticate } = require("../middlewares/auth");

router.use(authenticate);

router.get("/", qualityController.getAllQualities);
router.get("/:id", qualityController.getQualityById);
router.post("/", validateQuality, qualityController.createQuality);
router.patch("/:id", validateQuality, qualityController.updateQuality);
router.patch("/:id/toggle-status", qualityController.toggleQualityStatus);
router.delete("/:id", qualityController.deleteQuality);

module.exports = router;

