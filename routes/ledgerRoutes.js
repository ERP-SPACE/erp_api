const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const {
  getLedgers,
  getLedger,
  createLedger,
  updateLedger,
  getLedgerTransactions,
  getLedgerBalance,
} = require("../controllers/ledgerController");

router.use(authenticate);

router.route("/").get(getLedgers).post(createLedger);

// Specific sub-routes MUST come before /:id
router.get("/:id/transactions", getLedgerTransactions);
router.get("/:id/balance", getLedgerBalance);

router.route("/:id")
  .get(getLedger)
  .put(updateLedger);

module.exports = router;
