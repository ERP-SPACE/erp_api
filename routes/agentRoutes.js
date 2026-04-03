const express = require("express");
const agentController = require("../controllers/agentController");
const { authenticate } = require("../middlewares/auth");

const router = express.Router();

router.use(authenticate);

router
  .route("/")
  .post(agentController.createAgent)
  .get(agentController.getAgents);

router.get("/code/:code", agentController.getAgentByCode);

router
  .route("/:id")
  .get(agentController.getAgentById)
  .patch(agentController.updateAgent);

router.patch("/:id/status", agentController.toggleAgentStatus);

router.post("/:id/party-commissions", agentController.upsertPartyCommission);
router.delete(
  "/:id/party-commissions/:customerId",
  agentController.removePartyCommission
);

router.post("/:id/commission-payouts", agentController.addCommissionPayout);
router.patch(
  "/:id/commission-payouts/:payoutId",
  agentController.updateCommissionPayout
);

router.post("/:id/kyc-documents", agentController.addKycDocument);
router.delete(
  "/:id/kyc-documents/:documentId",
  agentController.removeKycDocument
);

module.exports = router;

