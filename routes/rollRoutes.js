const express = require("express");
const router = express.Router();
const rollController = require("../controllers/rollController");
const { authenticate } = require("../middlewares/auth");

router.use(authenticate);

router.get("/", rollController.getAllRolls);
router.get("/summary", rollController.getInventorySummary);
router.get("/unmapped", rollController.getUnmappedRolls);
router.get("/barcode/:barcode", rollController.getRollByBarcode);
router.get("/:id/history", rollController.getRollHistory);
router.get("/:id", rollController.getRoll);
router.post("/", rollController.createRolls);
router.patch("/:id", rollController.updateRoll);

router.post("/map", rollController.mapUnmappedRolls);
router.post("/allocate", rollController.allocateRolls);
router.post("/deallocate", rollController.deallocateRolls);
router.post("/dispatch", rollController.dispatchRolls);
router.post("/return", rollController.handleReturn);
router.patch("/:id/scrap", rollController.markAsScrap);

module.exports = router;
