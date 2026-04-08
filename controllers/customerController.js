const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const SalesInvoice = require("../models/SalesInvoice");
const SalesOrder = require("../models/SalesOrder");
const CustomerRate = require("../models/CustomerRate");
const Agent = require("../models/Agent");
const numberingService = require("../services/numberingService");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

// Get all customers
const getCustomers = handleAsyncErrors(async (req, res) => {
  const { active, customerGroupId, isBlocked } = req.query;
  const filter = {};

  if (active !== undefined) filter.active = active === "true";
  if (customerGroupId) {
    filter.$or = [
      { customerGroupId },
      { customerGroupIds: customerGroupId },
    ];
  }
  if (isBlocked !== undefined)
    filter["creditPolicy.isBlocked"] = isBlocked === "true";

  const customers = await Customer.find(filter)
    .populate(customerRelationsPopulate)
    .sort({ companyName: 1 });

  res.json({
    success: true,
    count: customers.length,
    data: customers,
  });
});

// Get single customer
const getCustomer = handleAsyncErrors(async (req, res) => {
  const customer = await Customer.findById(req.params.id).populate(
    customerRelationsPopulate
  );

  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({
    success: true,
    data: customer,
  });
});

// Helper function to sanitize numeric values from formatted strings
const sanitizeNumericValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Remove currency symbols, commas, and whitespace
    const cleaned = value.replace(/[₹$€£,\s]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  return value;
};

// Helper to normalize block rule values coming from UI
const normalizeBlockRule = (rawRule) => {
  if (!rawRule) return rawRule;
  const map = {
    CREDIT_OVER_DUE: "OVER_LIMIT", // legacy UI option label
    DAYS_OVER_DUE: "OVER_DUE",
    ANY: "BOTH",
  };
  if (typeof rawRule === "string") {
    const upper = rawRule.trim().toUpperCase();
    return map[upper] || upper;
  }
  return rawRule;
};

// Helper function to sanitize credit policy
const sanitizeCreditPolicy = (creditPolicy) => {
  if (!creditPolicy) return creditPolicy;
  return {
    ...creditPolicy,
    creditLimit: sanitizeNumericValue(creditPolicy.creditLimit),
    creditDays:
      typeof creditPolicy.creditDays === "string"
        ? parseInt(creditPolicy.creditDays.replace(/[,\s]/g, "")) || 0
        : creditPolicy.creditDays,
    graceDays:
      typeof creditPolicy.graceDays === "string"
        ? parseInt(creditPolicy.graceDays.replace(/[,\s]/g, "")) || 0
        : creditPolicy.graceDays,
    blockRule: normalizeBlockRule(creditPolicy.blockRule),
  };
};

const normalizeCustomerGroupIds = (groupIds, fallback) => {
  let ids = [];

  if (Array.isArray(groupIds)) {
    ids = groupIds;
  } else if (groupIds) {
    ids = [groupIds];
  }

  if ((!ids || ids.length === 0) && fallback) {
    ids = Array.isArray(fallback) ? fallback : [fallback];
  }

  const normalized = (ids || [])
    .filter(Boolean)
    .map((id) => {
      if (typeof id === 'object' && id !== null) {
        if (id._id) return id._id.toString();
        if (id.toString) return id.toString();
      }
      return id;
    });

  return [...new Set(normalized)];
};

const normalizeAgentId = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Attempt to parse JSON stringified object
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed._id || parsed.id || parsed.value || null;
      } catch (err) {
        // fall through
      }
    }
    return trimmed;
  }
  if (typeof raw === "object") {
    return raw._id || raw.id || raw.value || null;
  }
  return null;
};

const validateAgentId = async (agentId) => {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return null;

  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw new AppError("Invalid agent id", 400, "INVALID_AGENT");
  }

  // Ensure we only use the normalized id for queries
  const agent = await Agent.findById(normalized);
  if (!agent) {
    throw new AppError("Agent not found", 400, "INVALID_AGENT");
  }

  return agent._id;
};

const syncAgentCustomerMapping = async (
  customerId,
  previousAgentId,
  nextAgentId
) => {
  const prev = normalizeAgentId(previousAgentId);
  const next = normalizeAgentId(nextAgentId);

  const operations = [];

  if (prev && (!next || prev !== next)) {
    operations.push(
      Agent.updateOne({ _id: prev }, { $pull: { customers: customerId } })
    );
  }

  if (next) {
    operations.push(
      Agent.updateOne({ _id: next }, { $addToSet: { customers: customerId } })
    );
  }

  if (operations.length) {
    await Promise.all(operations);
  }
};

const customerRelationsPopulate = [
  { path: "customerGroupId", select: "name code description" },
  { path: "customerGroupIds", select: "name code description" },
  { path: "agentId", select: "name agentCode phone" },
];

// Create customer
const createCustomer = handleAsyncErrors(async (req, res) => {
  const {
    state,
    address,
    customerGroupId,
    customerGroupIds,
    contactPersons,
    referralSource,
    creditPolicy,
    baseRate44,
    companyName,
    agentId,
    gstin,
    pan,
    businessInfo,
  } = req.body;

  const normalizedCompanyName = companyName || req.body.name;

  if (!normalizedCompanyName) {
    throw new AppError(
      "Company name is required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const normalizedGroups = normalizeCustomerGroupIds(
    customerGroupIds,
    customerGroupId
  );

  if (!normalizedGroups.length) {
    throw new AppError(
      "At least one customer group is required",
      400,
      "VALIDATION_ERROR"
    );
  }

  // Sanitize numeric fields
  const sanitizedCreditPolicy = sanitizeCreditPolicy(creditPolicy);
  const sanitizedBaseRate44 = sanitizeNumericValue(baseRate44);
  const sanitizedBusinessInfo = businessInfo ? {
    ...businessInfo,
    targetSalesMeters: sanitizeNumericValue(businessInfo.targetSalesMeters),
  } : businessInfo;

  const normalizedAgentId = await validateAgentId(agentId);

  const customer = await Customer.create({
    state,
    address,
    companyName: normalizedCompanyName,
    gstin,
    pan,
    customerGroupId: normalizedGroups[0],
    customerGroupIds: normalizedGroups,
    agentId: normalizedAgentId,
    contactPersons,
    referral: referralSource,
    creditPolicy: sanitizedCreditPolicy,
    baseRate44: sanitizedBaseRate44,
    businessInfo: sanitizedBusinessInfo,
  });

  await syncAgentCustomerMapping(customer._id, null, normalizedAgentId);

  const populatedCustomer = await Customer.findById(customer._id).populate(
    customerRelationsPopulate
  );

  res.status(201).json({
    success: true,
    data: populatedCustomer,
  });
});

// Update customer
const updateCustomer = handleAsyncErrors(async (req, res) => {
  // Handle referralSource mapping to referral
  if (req.body.referralSource) {
    req.body.referral = req.body.referralSource;
    delete req.body.referralSource;
  }

  // Sanitize numeric fields before updating
  const existingCustomer = await Customer.findById(req.params.id);

  if (!existingCustomer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  const previousBaseRate44 = existingCustomer.baseRate44;

  const previousAgentId = existingCustomer.agentId;

  const updateData = { ...req.body };

  if (updateData.name && !updateData.companyName) {
    updateData.companyName = updateData.name;
  }
  delete updateData.name;

  if (
    Object.prototype.hasOwnProperty.call(updateData, "customerGroupIds") ||
    Object.prototype.hasOwnProperty.call(updateData, "customerGroupId")
  ) {
    const normalizedGroups = normalizeCustomerGroupIds(
      updateData.customerGroupIds,
      updateData.customerGroupId
    );

    if (!normalizedGroups.length) {
      throw new AppError(
        "At least one customer group is required",
        400,
        "VALIDATION_ERROR"
      );
    }

    updateData.customerGroupIds = normalizedGroups;
    updateData.customerGroupId = normalizedGroups[0];
  }
  
  if (
    Object.prototype.hasOwnProperty.call(updateData, "agentId")
  ) {
    updateData.agentId = await validateAgentId(updateData.agentId);
  }

  if (updateData.creditPolicy) {
    updateData.creditPolicy = sanitizeCreditPolicy(updateData.creditPolicy);
  }
  
  if (updateData.baseRate44 !== undefined) {
    updateData.baseRate44 = sanitizeNumericValue(updateData.baseRate44);
  }
  
  if (updateData.businessInfo) {
    updateData.businessInfo = {
      ...updateData.businessInfo,
      targetSalesMeters: sanitizeNumericValue(updateData.businessInfo.targetSalesMeters),
    };
  }

  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    updateData,
    {
      new: true,
      runValidators: true,
    }
  ).populate(customerRelationsPopulate);

  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  await syncAgentCustomerMapping(
    customer._id,
    previousAgentId,
    customer.agentId
  );

  res.json({
    success: true,
    data: customer,
  });
});

// Check credit — computes real exposure from open SalesOrders
const checkCredit = handleAsyncErrors(async (req, res) => {
  const customerId = req.params.id;
  const customer = await Customer.findById(customerId).populate(
    customerRelationsPopulate
  );

  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  const isBlocked = customer.creditPolicy?.isBlocked || false;
  const blockReason = customer.creditPolicy?.blockReason || null;
  const creditLimit = Number(customer.creditPolicy?.creditLimit) || 0;

  // Calculate pending SO value (Confirmed or InProgress)
  const SalesOrder = require("../models/SalesOrder");
  const pendingSOAgg = await SalesOrder.aggregate([
    {
      $match: {
        customerId: customer._id,
        status: { $in: ["Confirmed", "InProgress"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$total" } } },
  ]);
  const pendingSOValue = pendingSOAgg[0]?.total || 0;

  const exposure = pendingSOValue;
  const availableCredit = Math.max(0, creditLimit - exposure);
  const overLimit = creditLimit > 0 && exposure > creditLimit;

  const result = {
    blocked: isBlocked || (customer.creditPolicy?.autoBlock && overLimit),
    reasons: [],
    creditLimit,
    exposure,
    pendingSOValue,
    outstandingAR: 0, // Will be populated when AR/invoicing is implemented
    availableCredit,
    overLimit,
  };

  if (isBlocked) result.reasons.push(blockReason || "Customer is manually blocked");
  if (overLimit) result.reasons.push(`Credit limit ₹${creditLimit.toLocaleString("en-IN")} exceeded by ₹${(exposure - creditLimit).toLocaleString("en-IN")}`);

  res.json({ success: true, data: result });
});

// Block customer
const blockCustomer = handleAsyncErrors(async (req, res) => {
  const { reason } = req.body;

  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  customer.creditPolicy.isBlocked = true;
  customer.creditPolicy.blockReason = reason;
  customer.creditPolicy.blockedAt = new Date();
  await customer.save();

  const populatedCustomer = await Customer.findById(customer._id).populate(
    customerRelationsPopulate
  );

  res.json({
    success: true,
    data: populatedCustomer,
  });
});

// Unblock customer
const unblockCustomer = handleAsyncErrors(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  customer.creditPolicy.isBlocked = false;
  customer.creditPolicy.blockReason = null;
  customer.creditPolicy.blockedAt = null;
  await customer.save();

  const populatedCustomer = await Customer.findById(customer._id).populate(
    customerRelationsPopulate
  );

  res.json({
    success: true,
    data: populatedCustomer,
  });
});

// Delete customer
const deleteCustomer = handleAsyncErrors(async (req, res) => {
  const customer = await Customer.findByIdAndDelete(req.params.id);

  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  await syncAgentCustomerMapping(customer._id, customer.agentId, null);

  res.json({
    success: true,
    message: "Customer deleted successfully",
  });
});

// Get all active per-SKU rates for a customer
const getCustomerRates = handleAsyncErrors(async (req, res) => {
  const rates = await CustomerRate.find({
    customerId: req.params.id,
    active: true,
    validTo: null,
  })
    .populate({ path: "skuId", select: "skuCode skuAlias widthInches productId",
      populate: { path: "productId", select: "productCode productAlias" } })
    .sort({ createdAt: -1 });

  res.json({ success: true, count: rates.length, data: rates });
});

// Set (create or replace) a SKU rate for a customer
const setCustomerRate = handleAsyncErrors(async (req, res) => {
  const { id } = req.params;
  const { skuId, baseRate, notes, isSpecialRate, specialRateReason } = req.body;

  if (!skuId)
    throw new AppError("SKU is required", 400, "VALIDATION_ERROR");
  if (baseRate === undefined || baseRate === null)
    throw new AppError("Rate is required", 400, "VALIDATION_ERROR");

  const numericRate = sanitizeNumericValue(baseRate);
  if (numericRate < 0)
    throw new AppError("Rate must be non-negative", 400, "VALIDATION_ERROR");

  // Expire any currently active rate for this customer+SKU
  await CustomerRate.updateMany(
    { customerId: id, skuId, active: true, validTo: null },
    { $set: { active: false, validTo: new Date() } }
  );

  const rate = await CustomerRate.create({
    customerId: id,
    skuId,
    baseRate: numericRate,
    validFrom: new Date(),
    validTo: null,
    active: true,
    notes: notes || "",
    isSpecialRate: isSpecialRate || false,
    specialRateReason: isSpecialRate ? specialRateReason : undefined,
    approvedBy: req.user?._id,
  });

  await rate.populate({ path: "skuId", select: "skuCode skuAlias widthInches productId",
    populate: { path: "productId", select: "productCode productAlias" } });

  res.status(201).json({ success: true, data: rate });
});

// Deactivate a SKU rate for a customer
const deleteCustomerRate = handleAsyncErrors(async (req, res) => {
  const { id, skuId } = req.params;

  const result = await CustomerRate.updateMany(
    { customerId: id, skuId, active: true, validTo: null },
    { $set: { active: false, validTo: new Date() } }
  );

  if (result.modifiedCount === 0) {
    throw new AppError(
      "No active rate found for this SKU",
      404,
      "RESOURCE_NOT_FOUND"
    );
  }

  res.json({ success: true, message: "SKU rate removed successfully" });
});

// Get full rate history for a customer (optionally filtered by SKU)
const getRateHistory = handleAsyncErrors(async (req, res) => {
  const { id } = req.params;
  const { skuId, limit } = req.query;

  const query = { customerId: id };
  if (skuId) query.skuId = skuId;

  const history = await CustomerRate.find(query)
    .populate({ path: "skuId", select: "skuCode skuAlias widthInches productId",
      populate: { path: "productId", select: "productCode productAlias" } })
    .populate("approvedBy", "name")
    .sort({ createdAt: -1 })
    .limit(parseInt(limit) || 50);

  res.json({ success: true, count: history.length, data: history });
});

// Bulk update rates for a customer (percentage or flat revision across all SKUs)
const bulkUpdateCustomerRates = handleAsyncErrors(async (req, res) => {
  const { id } = req.params;
  const { rateUpdates = [] } = req.body;

  if (!Array.isArray(rateUpdates) || !rateUpdates.length) {
    throw new AppError("rateUpdates array is required", 400, "VALIDATION_ERROR");
  }

  const results = { updated: [], failed: [] };

  for (const update of rateUpdates) {
    const { skuId, baseRate, notes, isSpecialRate, specialRateReason } = update;
    if (!skuId || baseRate === undefined || baseRate === null) {
      results.failed.push({ skuId, reason: "skuId and baseRate are required" });
      continue;
    }

    const numericRate = sanitizeNumericValue(baseRate);
    if (numericRate < 0) {
      results.failed.push({ skuId, reason: "Rate must be non-negative" });
      continue;
    }

    try {
      // Expire existing active rate
      await CustomerRate.updateMany(
        { customerId: id, skuId, active: true, validTo: null },
        { $set: { active: false, validTo: new Date() } }
      );

      const rate = await CustomerRate.create({
        customerId: id,
        skuId,
        baseRate: numericRate,
        validFrom: new Date(),
        validTo: null,
        active: true,
        notes: notes || "",
        isSpecialRate: isSpecialRate || false,
        specialRateReason: isSpecialRate ? specialRateReason : undefined,
        approvedBy: req.user?._id,
      });

      results.updated.push({ skuId, rateId: rate._id, baseRate: numericRate });
    } catch (err) {
      results.failed.push({ skuId, reason: err.message });
    }
  }

  res.json({ success: true, data: results });
});

module.exports = {
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  checkCredit,
  blockCustomer,
  unblockCustomer,
  deleteCustomer,
  getCustomerRates,
  setCustomerRate,
  deleteCustomerRate,
  getRateHistory,
  bulkUpdateCustomerRates,
};
