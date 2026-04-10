const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getDeliveryChallans,
  getDeliveryChallan,
  createDeliveryChallan,
  postDeliveryChallan,
  updateDeliveryChallan,
  closeDeliveryChallan,
} = require("../controllers/deliveryChallanController");

// All routes require authentication
router.use(authenticate);

router
  .route("/")
  .get(getDeliveryChallans)
  .post(createDeliveryChallan);

router
  .route("/:id")
  .get(getDeliveryChallan)
  .put(updateDeliveryChallan);

router.post("/:id/post", postDeliveryChallan);
router.post("/:id/close", closeDeliveryChallan);

module.exports = router;
