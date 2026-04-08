const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getVouchers,
  getVoucher,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  postVoucher,
} = require("../controllers/voucherController");

router.use(authenticate);

router.route("/").get(getVouchers).post(createVoucher);

router.route("/:id")
  .get(getVoucher)
  .put(updateVoucher)
  .delete(deleteVoucher);

router.post("/:id/post", postVoucher);

module.exports = router;
