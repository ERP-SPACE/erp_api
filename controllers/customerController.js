const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const SalesInvoice = require("../models/SalesInvoice");
const SalesOrder = require("../models/SalesOrder");
const BaseRate = require("../models/BaseRate");
const RateHistory = require("../models/RateHistory");
const customerService = require("../services/customerService");
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

// Sales summary for a customer (for detail view dashboards)
const getCustomerSalesSummary = handleAsyncErrors(async (req, res) => {
  const customerId = req.params.id;
  const now = new Date();

  if (!mongoose.Types.ObjectId.isValid(customerId)) {
    throw new AppError("Invalid customer id", 400, "INVALID_CUSTOMER");
  }

  const customer = await Customer.findById(customerId).select("_id");
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  const [agg] = await SalesInvoice.aggregate([
    {
      $match: {
        customerId: customer._id,
        status: "Posted",
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalAmount: { $sum: { $ifNull: ["$total", 0] } },
            },
          },
        ],
        meters: [
          { $unwind: { path: "$lines", preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: null,
              totalSalesMeters: {
                $sum: { $ifNull: ["$lines.billedLengthMeters", 0] },
              },
            },
          },
        ],
        outstanding: [
          {
            $match: {
              paymentStatus: { $ne: "Paid" },
            },
          },
          {
            $group: {
              _id: null,
              outstanding: {
                $sum: {
                  $cond: [
                    { $gt: ["$outstandingAmount", 0] },
                    "$outstandingAmount",
                    {
                      $subtract: [
                        { $ifNull: ["$total", 0] },
                        { $ifNull: ["$paidAmount", 0] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ],
        outstandingDue: [
          {
            $match: {
              paymentStatus: { $ne: "Paid" },
              dueDate: { $lte: now },
            },
          },
          {
            $group: {
              _id: null,
              outstandingDue: {
                $sum: {
                  $cond: [
                    { $gt: ["$outstandingAmount", 0] },
                    "$outstandingAmount",
                    {
                      $subtract: [
                        { $ifNull: ["$total", 0] },
                        { $ifNull: ["$paidAmount", 0] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
    {
      $project: {
        totalAmount: {
          $ifNull: [{ $arrayElemAt: ["$totals.totalAmount", 0] }, 0],
        },
        totalSalesMeters: {
          $ifNull: [{ $arrayElemAt: ["$meters.totalSalesMeters", 0] }, 0],
        },
        outstanding: {
          $ifNull: [{ $arrayElemAt: ["$outstanding.outstanding", 0] }, 0],
        },
        outstandingDue: {
          $ifNull: [
            { $arrayElemAt: ["$outstandingDue.outstandingDue", 0] },
            0,
          ],
        },
      },
    },
  ]);

  res.json({
    success: true,
    data: {
      customerId,
      totalSalesMeters: agg?.totalSalesMeters || 0,
      totalAmount: agg?.totalAmount || 0,
      outstanding: agg?.outstanding || 0,
      outstandingDue: agg?.outstandingDue || 0,
      asOf: now,
    },
  });
});

// Bulk sales summary for customers (used in agent modal customer table)
const getCustomerSalesSummaryBulk = handleAsyncErrors(async (req, res) => {
  const { customerIds = [] } = req.body || {};
  const now = new Date();

  const ids = Array.isArray(customerIds)
    ? customerIds.filter(Boolean).map(String)
    : [];

  const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const objectIds = validIds.map((id) => new mongoose.Types.ObjectId(id));

  if (!objectIds.length) {
    return res.json({ success: true, data: [] });
  }

  const totalsAgg = await SalesInvoice.aggregate([
    { $match: { customerId: { $in: objectIds }, status: "Posted" } },
    {
      $group: {
        _id: "$customerId",
        totalAmount: { $sum: { $ifNull: ["$total", 0] } },
        outstanding: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ["$paymentStatus", "Paid"] }] },
              {
                $cond: [
                  { $gt: ["$outstandingAmount", 0] },
                  "$outstandingAmount",
                  {
                    $subtract: [
                      { $ifNull: ["$total", 0] },
                      { $ifNull: ["$paidAmount", 0] },
                    ],
                  },
                ],
              },
              0,
            ],
          },
        },
      },
    },
  ]);

  const dueAgg = await SalesInvoice.aggregate([
    {
      $match: {
        customerId: { $in: objectIds },
        status: "Posted",
        paymentStatus: { $ne: "Paid" },
        dueDate: { $lte: now },
      },
    },
    {
      $group: {
        _id: "$customerId",
        outstandingDue: {
          $sum: {
            $cond: [
              { $gt: ["$outstandingAmount", 0] },
              "$outstandingAmount",
              {
                $subtract: [
                  { $ifNull: ["$total", 0] },
                  { $ifNull: ["$paidAmount", 0] },
                ],
              },
            ],
          },
        },
      },
    },
  ]);

  const metersAgg = await SalesInvoice.aggregate([
    { $match: { customerId: { $in: objectIds }, status: "Posted" } },
    { $unwind: { path: "$lines", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: "$customerId",
        totalSalesMeters: {
          $sum: { $ifNull: ["$lines.billedLengthMeters", 0] },
        },
      },
    },
  ]);

  const byId = new Map();
  totalsAgg.forEach((r) => {
    byId.set(String(r._id), {
      customerId: String(r._id),
      totalSalesMeters: 0,
      totalAmount: r.totalAmount || 0,
      outstanding: r.outstanding || 0,
      outstandingDue: 0,
      asOf: now,
    });
  });
  metersAgg.forEach((r) => {
    const key = String(r._id);
    const cur = byId.get(key) || {
      customerId: key,
      totalSalesMeters: 0,
      totalAmount: 0,
      outstanding: 0,
      outstandingDue: 0,
      asOf: now,
    };
    cur.totalSalesMeters = r.totalSalesMeters || 0;
    byId.set(key, cur);
  });
  dueAgg.forEach((r) => {
    const key = String(r._id);
    const cur = byId.get(key) || {
      customerId: key,
      totalSalesMeters: 0,
      totalAmount: 0,
      outstanding: 0,
      outstandingDue: 0,
      asOf: now,
    };
    cur.outstandingDue = r.outstandingDue || 0;
    byId.set(key, cur);
  });

  const result = validIds.map((id) => byId.get(id) || {
    customerId: id,
    totalSalesMeters: 0,
    totalAmount: 0,
    outstanding: 0,
    outstandingDue: 0,
    asOf: now,
  });

  res.json({ success: true, data: result });
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

const sanitizeContactPersons = (contactPersons) => {
  if (!Array.isArray(contactPersons)) return [];

  const trimmed = contactPersons.map((person = {}) => ({
    ...person,
    name: typeof person.name === "string" ? person.name.trim() : "",
    phone: typeof person.phone === "string" ? person.phone.trim() : "",
    designation:
      typeof person.designation === "string" ? person.designation.trim() : "",
    whatsapp:
      typeof person.whatsapp === "string" ? person.whatsapp.trim() : "",
    email: typeof person.email === "string" ? person.email.trim() : "",
  }));

  const nonEmpty = trimmed.filter(
    (person) =>
      person.name ||
      person.phone ||
      person.designation ||
      person.whatsapp ||
      person.email
  );

  if (!nonEmpty.length) return [];

  if (!nonEmpty.some((person) => person.isPrimary)) {
    nonEmpty[0].isPrimary = true;
  }

  return nonEmpty;
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

const mapCustomerRateForUi = (rateDoc) => {
  if (!rateDoc) return rateDoc;

  const rate =
    typeof rateDoc.toObject === "function"
      ? rateDoc.toObject({ virtuals: true })
      : { ...rateDoc };

  const baseRateVal =
    rate.baseRate !== undefined && rate.baseRate !== null
      ? rate.baseRate
      : rate.rate;

  return {
    ...rate,
    baseRate: baseRateVal,
    customerid: rate.customerId,
    productid: rate.productId,
    skuid: rate.skuId,
    validFrom: rate.validFrom || rate.updatedAt || rate.createdAt,
  };
};

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
  const sanitizedContactPersons = sanitizeContactPersons(contactPersons);
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
    contactPersons: sanitizedContactPersons,
    referral: referralSource,
    creditPolicy: sanitizedCreditPolicy,
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

  if (Object.prototype.hasOwnProperty.call(updateData, "contactPersons")) {
    updateData.contactPersons = sanitizeContactPersons(updateData.contactPersons);
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

  // Calculate pending SO value (Confirmed or PartiallyFulfilled)
  const pendingSOAgg = await SalesOrder.aggregate([
    {
      $match: {
        customerId: customer._id,
        status: { $in: ["Confirmed", "PartiallyFulfilled"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$total" } } },
  ]);
  const pendingSOValue = pendingSOAgg[0]?.total || 0;

  // Outstanding AR from posted invoices not fully paid
  const outstandingAgg = await SalesInvoice.aggregate([
    {
      $match: {
        customerId: customer._id,
        status: "Posted",
        paymentStatus: { $ne: "Paid" },
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $cond: [
              { $gt: ["$outstandingAmount", 0] },
              "$outstandingAmount",
              { $subtract: [{ $ifNull: ["$total", 0] }, { $ifNull: ["$paidAmount", 0] }] },
            ],
          },
        },
      },
    },
  ]);
  const outstandingAR = outstandingAgg[0]?.total || 0;

  const exposure = pendingSOValue + outstandingAR;
  const availableCredit = Math.max(0, creditLimit - exposure);
  const overLimit = creditLimit > 0 && exposure > creditLimit;

  const result = {
    blocked: isBlocked || (customer.creditPolicy?.autoBlock && overLimit),
    reasons: [],
    creditLimit,
    exposure,
    pendingSOValue,
    outstandingAR,
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
  const customer = await Customer.findById(req.params.id);

  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  const brIds = await BaseRate.find({ customerId: customer._id }).distinct("_id");
  if (brIds.length) {
    await RateHistory.deleteMany({ baseRateId: { $in: brIds } });
  }
  await BaseRate.deleteMany({ customerId: customer._id });

  await Customer.findByIdAndDelete(req.params.id);
  await syncAgentCustomerMapping(customer._id, customer.agentId, null);

  res.json({
    success: true,
    message: "Customer deleted successfully",
  });
});

// Get all active per-Product rates for a customer (BaseRate with customerId)
const getCustomerRates = handleAsyncErrors(async (req, res) => {
  const rates = await customerService.getCustomerBaseRates(req.params.id);

  res.json({
    success: true,
    count: rates.length,
    data: rates.map(mapCustomerRateForUi),
  });
});

// Set (create or replace) a Product rate for a customer
const setCustomerRate = handleAsyncErrors(async (req, res) => {
  const { id } = req.params;
  const {
    productId,
    productid,
    skuId,
    skuid,
    baseRate,
    rate: incomingRate,
    notes,
    isSpecialRate,
    specialRateReason,
  } = req.body;
  const resolvedProductId = productId || productid;
  const resolvedBaseRate =
    baseRate !== undefined && baseRate !== null ? baseRate : incomingRate;

  let effectiveProductId = resolvedProductId;

  // Backward compatibility: allow skuId and map it to productId
  if (!effectiveProductId && (skuId || skuid)) {
    const SKU = require("../models/SKU");
    const skuDoc = await SKU.findById(skuId || skuid).select("productId");
    effectiveProductId = skuDoc?.productId || null;
  }

  if (!effectiveProductId)
    throw new AppError("Product is required", 400, "VALIDATION_ERROR");
  if (resolvedBaseRate === undefined || resolvedBaseRate === null)
    throw new AppError("Rate is required", 400, "VALIDATION_ERROR");

  const numericRate = sanitizeNumericValue(resolvedBaseRate);
  if (numericRate < 0)
    throw new AppError("Rate must be non-negative", 400, "VALIDATION_ERROR");

  let noteParts = [notes].filter(Boolean);
  if (isSpecialRate && specialRateReason) {
    noteParts.push(`Special: ${specialRateReason}`);
  }
  const mergedNotes = noteParts.join(" — ");

  const saved = await customerService.setCustomerRate(
    id,
    effectiveProductId,
    numericRate,
    req.user?._id,
    mergedNotes
  );

  res.status(201).json({ success: true, data: mapCustomerRateForUi(saved) });
});

// Remove a Product benchmark rate for a customer
const deleteCustomerRate = handleAsyncErrors(async (req, res) => {
  const { id, productId } = req.params;

  await customerService.deleteCustomerBaseRate(id, productId);

  res.json({ success: true, message: "Product rate removed successfully" });
});

// Get full rate history for a customer (optionally filtered by Product)
const getRateHistory = handleAsyncErrors(async (req, res) => {
  const { id } = req.params;
  const { productId, productid, skuId, skuid, limit } = req.query;

  const query = { customerId: id };
  if (productId || productid) query.productId = productId || productid;
  // Backward compatibility for old query params
  if (!query.productId && (skuId || skuid)) {
    const SKU = require("../models/SKU");
    const skuDoc = await SKU.findById(skuId || skuid).select("productId");
    if (skuDoc?.productId) query.productId = skuDoc.productId;
  }

  const history = await customerService.getCustomerRateHistory(
    id,
    query.productId,
    parseInt(limit, 10) || 50
  );

  res.json({
    success: true,
    count: history.length,
    data: history.map(mapCustomerRateForUi),
  });
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
    const resolvedProductId = update.productId || update.productid;
    const resolvedBaseRate =
      update.baseRate !== undefined && update.baseRate !== null
        ? update.baseRate
        : update.rate;
    const { notes, isSpecialRate, specialRateReason } = update;

    if (
      !resolvedProductId ||
      resolvedBaseRate === undefined ||
      resolvedBaseRate === null
    ) {
      results.failed.push({
        productId: resolvedProductId,
        reason: "productId and baseRate are required",
      });
      continue;
    }

    const numericRate = sanitizeNumericValue(resolvedBaseRate);
    if (numericRate < 0) {
      results.failed.push({
        productId: resolvedProductId,
        reason: "Rate must be non-negative",
      });
      continue;
    }

    try {
      let noteParts = [notes].filter(Boolean);
      if (isSpecialRate && specialRateReason) {
        noteParts.push(`Special: ${specialRateReason}`);
      }
      const mergedNotes = noteParts.join(" — ");

      const rate = await customerService.setCustomerRate(
        id,
        resolvedProductId,
        numericRate,
        req.user?._id,
        mergedNotes
      );

      results.updated.push({
        ...mapCustomerRateForUi(rate),
        rateId: rate._id,
        baseRate: numericRate,
      });
    } catch (err) {
      results.failed.push({ productId: resolvedProductId, reason: err.message });
    }
  }

  res.json({ success: true, data: results });
});

module.exports = {
  getCustomers,
  getCustomer,
  getCustomerSalesSummary,
  getCustomerSalesSummaryBulk,
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
