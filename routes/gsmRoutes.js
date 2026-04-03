const express = require("express");
const router = express.Router();
const gsmController = require("../controllers/gsmController");
const { validateGSM } = require("../validators/gsmValidator");
const { authenticate } = require("../middlewares/auth");

router.use(authenticate);

router.get("/", gsmController.getAllGSMs);
router.get("/:id", gsmController.getGSMById);
router.post("/", validateGSM, gsmController.createGSM);
router.patch("/:id", validateGSM, gsmController.updateGSM);
router.patch("/:id/toggle-status", gsmController.toggleGSMStatus);
router.delete("/:id", gsmController.deleteGSM);

module.exports = router;

