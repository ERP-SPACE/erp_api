const agentService = require("../services/agentService");
const catchAsync = require("../utils/catchAsync");

class AgentController {
  createAgent = catchAsync(async (req, res) => {
    const agent = await agentService.createAgent(req.body);

    res.status(201).json({
      success: true,
      message: "Agent created successfully",
      data: agent,
    });
  });

  getAgents = catchAsync(async (req, res) => {
    const filters = {
      active:
        req.query.active === "true"
          ? true
          : req.query.active === "false"
          ? false
          : undefined,
      state: req.query.state,
      blockNewSalesForAllParties:
        req.query.blockNewSalesForAllParties === "true"
          ? true
          : req.query.blockNewSalesForAllParties === "false"
          ? false
          : undefined,
      blockNewDeliveriesForAllParties:
        req.query.blockNewDeliveriesForAllParties === "true"
          ? true
          : req.query.blockNewDeliveriesForAllParties === "false"
          ? false
          : undefined,
      search: req.query.search,
    };

    const pagination = {
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await agentService.getAgents(filters, pagination);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  getAgentById = catchAsync(async (req, res) => {
    const agent = await agentService.getAgentById(req.params.id);

    res.status(200).json({
      success: true,
      data: agent,
    });
  });

  getAgentByCode = catchAsync(async (req, res) => {
    const agent = await agentService.getAgentByCode(req.params.code);

    res.status(200).json({
      success: true,
      data: agent,
    });
  });

  getAgentRateHistory = catchAsync(async (req, res) => {
    const history = await agentService.getAgentRateHistory(
      req.params.id,
      req.query
    );

    res.status(200).json({
      success: true,
      count: history.length,
      data: history,
    });
  });

  updateAgent = catchAsync(async (req, res) => {
    const agent = await agentService.updateAgent(req.params.id, req.body);

    res.status(200).json({
      success: true,
      message: "Agent updated successfully",
      data: agent,
    });
  });

  toggleAgentStatus = catchAsync(async (req, res) => {
    const agent = await agentService.toggleAgentStatus(req.params.id);

    res.status(200).json({
      success: true,
      message: `Agent ${agent.active ? "activated" : "deactivated"} successfully`,
      data: agent,
    });
  });

  upsertPartyCommission = catchAsync(async (req, res) => {
    const agent = await agentService.upsertPartyCommission(
      req.params.id,
      req.body,
      {
        changedBy: req.userId,
      }
    );

    res.status(200).json({
      success: true,
      message: "Party commission updated successfully",
      data: agent,
    });
  });

  removePartyCommission = catchAsync(async (req, res) => {
    const agent = await agentService.removePartyCommission(
      req.params.id,
      req.params.customerId,
      {
        changedBy: req.userId,
        notes: req.body ? req.body.notes : undefined,
      }
    );

    res.status(200).json({
      success: true,
      message: "Party commission removed successfully",
      data: agent,
    });
  });

  addCommissionPayout = catchAsync(async (req, res) => {
    const agent = await agentService.addCommissionPayout(
      req.params.id,
      req.body
    );

    res.status(201).json({
      success: true,
      message: "Commission payout recorded successfully",
      data: agent,
    });
  });

  updateCommissionPayout = catchAsync(async (req, res) => {
    const agent = await agentService.updateCommissionPayout(
      req.params.id,
      req.params.payoutId,
      req.body
    );

    res.status(200).json({
      success: true,
      message: "Commission payout updated successfully",
      data: agent,
    });
  });

  addKycDocument = catchAsync(async (req, res) => {
    const agent = await agentService.addKycDocument(req.params.id, req.body);

    res.status(201).json({
      success: true,
      message: "KYC document added successfully",
      data: agent,
    });
  });

  removeKycDocument = catchAsync(async (req, res) => {
    const agent = await agentService.removeKycDocument(
      req.params.id,
      req.params.documentId
    );

    res.status(200).json({
      success: true,
      message: "KYC document removed successfully",
      data: agent,
    });
  });
}

module.exports = new AgentController();

