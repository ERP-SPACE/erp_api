const express = require("express");
const router = express.Router();
const customerGroupController = require("../controllers/customerGroupController");
const { authenticate } = require("../middlewares/auth");

// All routes require authentication
router.use(authenticate);

router.get("/", customerGroupController.getAllCustomerGroups);
router.get("/:id", customerGroupController.getCustomerGroupById);

router.post("/", customerGroupController.createCustomerGroup);
router.patch("/:id", customerGroupController.updateCustomerGroup);
router.patch(
  "/:id/toggle-status",
  customerGroupController.toggleCustomerGroupStatus
);
router.delete("/:id", customerGroupController.deleteCustomerGroup);

module.exports = router;

