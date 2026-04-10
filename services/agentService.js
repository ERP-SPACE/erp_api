const mongoose = require("mongoose");
const Agent = require("../models/Agent");
const BaseRate = require("../models/BaseRate");
const RateHistory = require("../models/RateHistory");
const SKU = require("../models/SKU");
require("../models/User");
const AppError = require("../utils/AppError");

const COMMISSION_METHODS = {
  PER_METER: "per_meter",
  PERCENTAGE: "percentage",
};

const POPULATE_OPTIONS = [
  { path: "customers", select: "name customerCode phone email" },
  {
    path: "defaultSkuRates.product",
    select:
      "productCode productAlias categoryId gsmId qualityId taxRate",
    populate: [
      { path: "categoryId", select: "name" },
      { path: "gsmId", select: "name value" },
      { path: "qualityId", select: "name" },
    ],
  },
  {
    path: "defaultSkuRates.sku",
    select: "skuCode skuAlias widthInches productId",
    populate: { path: "productId", select: "productCode productAlias" },
  },
  {
    path: "partyCommissions.customer",
    select: "name customerCode phone email",
  },
  { path: "commissionPayouts.customer", select: "name customerCode" },
  { path: "commissionChanges.customer", select: "name customerCode" },
  { path: "commissionChanges.changedBy", select: "name email" },
];

const normalizeRateEntry = (rate = {}) => {
  if (!rate || typeof rate !== "object") {
    return rate;
  }

  const productId = normalizeAgentId(rate.product ?? rate.productId);
  const skuId = normalizeAgentId(rate.skuId ?? rate.skuid ?? rate.sku);

  const next = { ...rate };
  if (productId) {
    next.product = productId;
  }
  if (skuId && !productId) {
    next.sku = skuId;
  }

  return next;
};

const normalizeDefaultSkuRates = (rates) => {
  if (!Array.isArray(rates)) {
    return rates;
  }

  return rates
    .map(normalizeRateEntry)
    .filter((rate) => rate && (rate.product || rate.sku));
};

/**
 * Resolves legacy SKU-only rows to { product, rate, notes } for storage and BaseRate sync.
 */
const resolveDefaultSkuRatesToProducts = async (rates) => {
  if (!Array.isArray(rates) || !rates.length) {
    return [];
  }

  const resolved = [];
  for (const rate of rates) {
    let productId = normalizeAgentId(rate.product);
    if (!productId) {
      const legacySkuId = normalizeAgentId(rate.sku);
      if (legacySkuId && mongoose.Types.ObjectId.isValid(legacySkuId)) {
        const skuDoc = await SKU.findById(legacySkuId)
          .select("productId")
          .lean();
        productId = skuDoc?.productId
          ? skuDoc.productId.toString()
          : null;
      }
    }

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      throw new AppError(
        "Each default rate must reference a valid product",
        400
      );
    }

    resolved.push({
      product: productId,
      rate: Number(rate.rate),
      notes: rate.notes || "",
    });
  }

  return resolved;
};

const mapDefaultSkuRateForUi = (agentId, rate = {}) => {
  const rawProduct = rate.product;
  const legacySku = rate.sku;

  let productId = normalizeAgentId(
    rawProduct && typeof rawProduct === "object" && rawProduct._id
      ? rawProduct._id
      : rawProduct
  );
  let productObj =
    rawProduct && typeof rawProduct === "object" ? rawProduct : null;

  if (!productId && legacySku && typeof legacySku === "object") {
    const pip = legacySku.productId;
    if (pip) {
      productObj = typeof pip === "object" ? pip : productObj;
      productId = normalizeAgentId(pip._id || pip);
    }
  }

  const skuId =
    legacySku && typeof legacySku === "object" && legacySku._id
      ? legacySku._id
      : normalizeAgentId(legacySku);

  return {
    ...rate,
    agentId,
    agentid: agentId,
    productId,
    productid: productId,
    product: productObj,
    skuId,
    skuid: skuId,
    sku: legacySku,
  };
};

const mapAgentForUi = (agentDoc) => {
  if (!agentDoc) {
    return agentDoc;
  }

  const agent =
    typeof agentDoc.toObject === "function"
      ? agentDoc.toObject({ virtuals: true })
      : { ...agentDoc };

  const agentId = agent._id;

  return {
    ...agent,
    agentId,
    agentid: agentId,
    defaultSkuRates: Array.isArray(agent.defaultSkuRates)
      ? agent.defaultSkuRates.map((rate) => mapDefaultSkuRateForUi(agentId, rate))
      : [],
  };
};

const mapAgentRateHistoryForUi = (historyDoc) => {
  if (!historyDoc) {
    return historyDoc;
  }

  const history =
    typeof historyDoc.toObject === "function"
      ? historyDoc.toObject({ virtuals: true })
      : { ...historyDoc };

  return {
    ...history,
    agentid: history.agentId,
    customerid: history.customerId,
    supplierid: history.supplierId,
    productid: history.productId,
  };
};

const normalizeCommissionPayload = (commission) => {
  if (!commission) {
    return null;
  }

  const payload = {
    customer: normalizeAgentId(commission.customer) || commission.customer,
    commissionType: commission.commissionType,
    amountPerMeter: undefined,
    percentage: undefined,
    applyByDefault:
      commission.applyByDefault === undefined
        ? true
        : Boolean(commission.applyByDefault),
  };

  if (commission.commissionType === COMMISSION_METHODS.PER_METER) {
    payload.amountPerMeter = commission.amountPerMeter;
  } else if (commission.commissionType === COMMISSION_METHODS.PERCENTAGE) {
    payload.percentage = commission.percentage;
  }

  return payload;
};

const normalizeAgentId = (rawId) => {
  if (!rawId) return null;

  // If it's a plain string, return trimmed
  if (typeof rawId === "string") {
    const trimmed = rawId.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed._id || parsed.id || null;
      } catch (err) {
        // fall through
      }
    }
    return trimmed;
  }

  // If it's an object, try common id keys
  if (typeof rawId === "object") {
    const candidate = rawId._id || rawId.id || rawId.value;
    if (candidate) return candidate.toString();
    if (typeof rawId.toString === "function") {
      const str = rawId.toString();
      return str && str !== "[object Object]" ? str : null;
    }
  }

  return null;
};

const buildHistoryRecord = (commission, effectiveFrom, notes) => {
  const timestamp = effectiveFrom ? new Date(effectiveFrom) : new Date();

  return {
    commissionType: commission.commissionType,
    amountPerMeter:
      commission.commissionType === COMMISSION_METHODS.PER_METER
        ? commission.amountPerMeter
        : undefined,
    percentage:
      commission.commissionType === COMMISSION_METHODS.PERCENTAGE
        ? commission.percentage
        : undefined,
    effectiveFrom: timestamp,
    notes,
  };
};

const validateCommissionPayload = (commission) => {
  if (!commission) {
    throw new AppError("Commission payload is required", 400);
  }

  if (!commission.customer) {
    throw new AppError("customer is required for party commission", 400);
  }

  if (!commission.commissionType) {
    throw new AppError("commissionType is required", 400);
  }

  if (
    commission.commissionType !== COMMISSION_METHODS.PER_METER &&
    commission.commissionType !== COMMISSION_METHODS.PERCENTAGE
  ) {
    throw new AppError("Invalid commissionType", 400);
  }

  if (
    commission.commissionType === COMMISSION_METHODS.PER_METER &&
    (commission.amountPerMeter === undefined ||
      commission.amountPerMeter === null)
  ) {
    throw new AppError(
      "amountPerMeter is required for per_meter commission",
      400
    );
  }

  if (
    commission.commissionType === COMMISSION_METHODS.PERCENTAGE &&
    (commission.percentage === undefined || commission.percentage === null)
  ) {
    throw new AppError("percentage is required for percentage commission", 400);
  }
};

const populateAgentQuery = (query) => {
  let populatedQuery = query;
  POPULATE_OPTIONS.forEach((option) => {
    populatedQuery = populatedQuery.populate(option);
  });
  return populatedQuery;
};

const populateAgentDoc = async (doc) => {
  if (!doc) {
    return doc;
  }

  for (const option of POPULATE_OPTIONS) {
    await doc.populate(option);
  }

  return doc;
};

const syncAgentDefaultSkuRates = async (agentId, previousRates = [], nextRates = []) => {
  if (!agentId || !mongoose.Types.ObjectId.isValid(agentId)) {
    throw new AppError("Invalid agent id", 400);
  }

  const normalizedNextRates = normalizeDefaultSkuRates(nextRates) || [];
  const existingBaseRates = await BaseRate.find({ agentId });

  const baseRateByProduct = new Map(
    existingBaseRates.map((baseRate) => [baseRate.productId.toString(), baseRate])
  );
  const previousRateByProduct = new Map(
    (previousRates || [])
      .map((rate) => normalizeRateEntry(rate))
      .filter((rate) => rate && (rate.product || rate.sku))
      .map((rate) => {
        const key = normalizeAgentId(rate.product || rate.sku);
        return key ? [key, rate] : null;
      })
      .filter(Boolean)
  );

  const nextProductIds = new Set();

  for (const rateEntry of normalizedNextRates) {
    const productId = normalizeAgentId(rateEntry.product);
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      throw new AppError("Invalid Product id in defaultSkuRates", 400);
    }

    nextProductIds.add(productId);

    const nextRateValue = Number(rateEntry.rate);
    const existingBaseRate = baseRateByProduct.get(productId);
    const previousEmbeddedRate = previousRateByProduct.get(productId);

    if (existingBaseRate) {
      const currentRateValue = Number(existingBaseRate.rate);
      if (currentRateValue !== nextRateValue) {
        await RateHistory.create({
          baseRateId: existingBaseRate._id,
          productId: existingBaseRate.productId,
          supplierId: existingBaseRate.supplierId,
          agentId: existingBaseRate.agentId,
          customerId: existingBaseRate.customerId,
          previousRate: existingBaseRate.rate,
        });

        existingBaseRate.rate = nextRateValue;
        await existingBaseRate.save();
      }
      continue;
    }

    const createdBaseRate = await BaseRate.create({
      agentId,
      productId,
      rate: nextRateValue,
    });

    const previousRateValue =
      previousEmbeddedRate?.rate !== undefined &&
      previousEmbeddedRate?.rate !== null
        ? Number(previousEmbeddedRate.rate)
        : null;

    if (
      previousRateValue !== null &&
      !Number.isNaN(previousRateValue) &&
      previousRateValue !== nextRateValue
    ) {
      await RateHistory.create({
        baseRateId: createdBaseRate._id,
        productId: createdBaseRate.productId,
        supplierId: createdBaseRate.supplierId,
        agentId: createdBaseRate.agentId,
        customerId: createdBaseRate.customerId,
        previousRate: previousRateValue,
      });
    }
  }

  const removedBaseRateIds = existingBaseRates
    .filter((baseRate) => !nextProductIds.has(baseRate.productId.toString()))
    .map((baseRate) => baseRate._id);

  if (removedBaseRateIds.length > 0) {
    await RateHistory.deleteMany({ baseRateId: { $in: removedBaseRateIds } });
    await BaseRate.deleteMany({ _id: { $in: removedBaseRateIds } });
  }
};

class AgentService {
  async createAgent(data) {
    if (!data.name) {
      throw new AppError("Agent name is required", 400);
    }

    if (!data.state) {
      throw new AppError("Agent state is required", 400);
    }

    if (!data.address || !data.address.line1 || !data.address.city) {
      throw new AppError("Agent address with line1 and city is required", 400);
    }

    if (!data.address.pincode) {
      throw new AppError("Agent pincode is required", 400);
    }

    if (!data.phone) {
      throw new AppError("Agent phone is required", 400);
    }

    const payload = { ...data };
    if (Object.prototype.hasOwnProperty.call(payload, "defaultSkuRates")) {
      const raw = normalizeDefaultSkuRates(payload.defaultSkuRates);
      payload.defaultSkuRates = raw.length
        ? await resolveDefaultSkuRatesToProducts(raw)
        : [];
    }

    if (payload.partyCommissions && payload.partyCommissions.length > 0) {
      payload.partyCommissions = payload.partyCommissions.map((commission) => {
        validateCommissionPayload(commission);
        const normalized = normalizeCommissionPayload(commission);
        normalized.history = [
          buildHistoryRecord(
            normalized,
            commission.effectiveFrom,
            commission.notes
          ),
        ];
        return normalized;
      });
    }

    const agent = await Agent.create(payload);
    if (Object.prototype.hasOwnProperty.call(payload, "defaultSkuRates")) {
      await syncAgentDefaultSkuRates(agent._id, [], payload.defaultSkuRates);
    }
    await populateAgentDoc(agent);
    return mapAgentForUi(agent);
  }

  async getAgents(filters = {}, pagination = {}) {
    const query = {};

    if (filters.active !== undefined) {
      query.active = filters.active;
    }

    if (filters.state) {
      query.state = filters.state;
    }


    if (filters.blockNewSalesForAllParties !== undefined) {
      query.blockNewSalesForAllParties = filters.blockNewSalesForAllParties;
    }

    if (filters.blockNewDeliveriesForAllParties !== undefined) {
      query.blockNewDeliveriesForAllParties =
        filters.blockNewDeliveriesForAllParties;
    }

    if (filters.search) {
      query.$or = [
        { name: { $regex: filters.search, $options: "i" } },
        { agentCode: { $regex: filters.search, $options: "i" } },
        { "address.city": { $regex: filters.search, $options: "i" } },
      ];
    }

    const page = parseInt(pagination.page, 10) || 1;
    const limit = parseInt(pagination.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const [agents, total] = await Promise.all([
      populateAgentQuery(
        Agent.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
      ),
      Agent.countDocuments(query),
    ]);

    return {
      agents: agents.map(mapAgentForUi),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getAgentById(id) {
    const normalizedId = normalizeAgentId(id);

    if (!normalizedId || !mongoose.Types.ObjectId.isValid(normalizedId)) {
      throw new AppError("Invalid agent id", 400);
    }

    const agent = await populateAgentQuery(Agent.findById(normalizedId));

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    return mapAgentForUi(agent);
  }

  async getAgentByCode(code) {
    if (!code) {
      throw new AppError("Agent code is required", 400);
    }

    const agent = await populateAgentQuery(
      Agent.findOne({ agentCode: code.toUpperCase() })
    );

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    return mapAgentForUi(agent);
  }

  async updateAgent(id, updateData) {
    const normalizedId = normalizeAgentId(id);

    if (!normalizedId || !mongoose.Types.ObjectId.isValid(normalizedId)) {
      throw new AppError("Invalid agent id", 400);
    }

    const immutableFields = ["agentCode", "customers"];
    immutableFields.forEach((field) => delete updateData[field]);
    if (Object.prototype.hasOwnProperty.call(updateData, "defaultSkuRates")) {
      const raw = normalizeDefaultSkuRates(updateData.defaultSkuRates);
      updateData.defaultSkuRates = raw.length
        ? await resolveDefaultSkuRatesToProducts(raw)
        : [];
    }

    const existingAgent = await Agent.findById(normalizedId);

    if (!existingAgent) {
      throw new AppError("Agent not found", 404);
    }

    const previousDefaultSkuRates = Array.isArray(existingAgent.defaultSkuRates)
      ? existingAgent.defaultSkuRates.map((rate) =>
          typeof rate.toObject === "function" ? rate.toObject() : { ...rate }
        )
      : [];

    const agent = await populateAgentQuery(
      Agent.findByIdAndUpdate(normalizedId, updateData, {
        new: true,
        runValidators: true,
      })
    );

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "defaultSkuRates")) {
      await syncAgentDefaultSkuRates(
        normalizedId,
        previousDefaultSkuRates,
        updateData.defaultSkuRates
      );
    }

    return mapAgentForUi(agent);
  }

  async toggleAgentStatus(id) {
    const normalizedId = normalizeAgentId(id);

    if (!normalizedId || !mongoose.Types.ObjectId.isValid(normalizedId)) {
      throw new AppError("Invalid agent id", 400);
    }

    const agent = await Agent.findById(normalizedId);

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    agent.active = !agent.active;
    await agent.save();

    return mapAgentForUi(await populateAgentDoc(agent));
  }

  async getAgentRateHistory(agentId, filters = {}) {
    const normalizedAgentId = normalizeAgentId(agentId);

    if (!normalizedAgentId || !mongoose.Types.ObjectId.isValid(normalizedAgentId)) {
      throw new AppError("Invalid agent id", 400);
    }

    const agent = await Agent.findById(normalizedAgentId);
    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    const query = { agentId: normalizedAgentId };
    if (filters.productId || filters.productid) {
      query.productId = filters.productId || filters.productid;
    }

    const history = await RateHistory.find(query)
      .populate({
        path: "productId",
        select: "productCode productAlias categoryId gsmId qualityId",
        populate: [
          { path: "categoryId", select: "name" },
          { path: "gsmId", select: "name" },
          { path: "qualityId", select: "name" },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(filters.limit, 10) || 50);

    return history.map(mapAgentRateHistoryForUi);
  }

  async upsertPartyCommission(agentId, commissionData, options = {}) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !normalizedAgentId ||
      !mongoose.Types.ObjectId.isValid(normalizedAgentId)
    ) {
      throw new AppError("Invalid agent id", 400);
    }

    validateCommissionPayload(commissionData);

    const agent = await Agent.findById(normalizedAgentId);

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    const normalized = normalizeCommissionPayload(commissionData);
    const effectiveDate = commissionData.effectiveFrom
      ? new Date(commissionData.effectiveFrom)
      : new Date();

    const existingEntry = agent.partyCommissions.find(
      (entry) =>
        entry.customer &&
        entry.customer.toString() === commissionData.customer.toString()
    );

    let changeRecord = null;

    if (existingEntry) {
      changeRecord = {
        customer: existingEntry.customer,
        changedBy: options.changedBy,
        previousCommissionType: existingEntry.commissionType,
        newCommissionType: normalized.commissionType,
        previousAmountPerMeter: existingEntry.amountPerMeter,
        newAmountPerMeter: normalized.amountPerMeter,
        previousPercentage: existingEntry.percentage,
        newPercentage: normalized.percentage,
        notes: commissionData.notes,
      };

      if (existingEntry.history && existingEntry.history.length > 0) {
        const latestHistory =
          existingEntry.history[existingEntry.history.length - 1];
        if (!latestHistory.effectiveTo) {
          latestHistory.effectiveTo = effectiveDate;
        }
      }

      existingEntry.commissionType = normalized.commissionType;
      existingEntry.amountPerMeter = normalized.amountPerMeter;
      existingEntry.percentage = normalized.percentage;
      existingEntry.applyByDefault = normalized.applyByDefault;

      existingEntry.history =
        existingEntry.history || [];
      existingEntry.history.push(
        buildHistoryRecord(normalized, effectiveDate, commissionData.notes)
      );
    } else {
      const historyRecord = buildHistoryRecord(
        normalized,
        effectiveDate,
        commissionData.notes
      );
      normalized.history = [historyRecord];
      agent.partyCommissions.push(normalized);

      changeRecord = {
        customer: commissionData.customer,
        changedBy: options.changedBy,
        newCommissionType: normalized.commissionType,
        newAmountPerMeter: normalized.amountPerMeter,
        newPercentage: normalized.percentage,
        notes: commissionData.notes,
      };
    }

    if (changeRecord) {
      agent.commissionChanges.push(changeRecord);
    }

    agent.markModified("partyCommissions");
    agent.markModified("commissionChanges");

    await agent.save();

    return mapAgentForUi(await populateAgentQuery(Agent.findById(agent._id)));
  }

  async removePartyCommission(agentId, customerId, options = {}) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !normalizedAgentId ||
      !mongoose.Types.ObjectId.isValid(normalizedAgentId)
    ) {
      throw new AppError("Invalid agent id", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      throw new AppError("Invalid customer id", 400);
    }

    const agent = await Agent.findById(normalizedAgentId);

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    const existingEntry = agent.partyCommissions.find(
      (entry) =>
        entry.customer && entry.customer.toString() === customerId.toString()
    );

    if (!existingEntry) {
      throw new AppError("Party commission not found for the customer", 404);
    }

    agent.partyCommissions = agent.partyCommissions.filter(
      (entry) =>
        entry.customer && entry.customer.toString() !== customerId.toString()
    );

    agent.commissionChanges.push({
      customer: existingEntry.customer,
      changedBy: options.changedBy,
      previousCommissionType: existingEntry.commissionType,
      previousAmountPerMeter: existingEntry.amountPerMeter,
      previousPercentage: existingEntry.percentage,
      notes: options.notes || "Commission mapping removed",
    });

    agent.markModified("partyCommissions");
    agent.markModified("commissionChanges");

    await agent.save();

    return mapAgentForUi(await populateAgentQuery(Agent.findById(agent._id)));
  }

  async addCommissionPayout(agentId, payoutData) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !normalizedAgentId ||
      !mongoose.Types.ObjectId.isValid(normalizedAgentId)
    ) {
      throw new AppError("Invalid agent id", 400);
    }

    if (!payoutData || payoutData.amount === undefined) {
      throw new AppError("Payout amount is required", 400);
    }

    const agent = await Agent.findById(normalizedAgentId);

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    agent.commissionPayouts.push({
      customer: payoutData.customer,
      reference: payoutData.reference,
      periodStart: payoutData.periodStart,
      periodEnd: payoutData.periodEnd,
      amount: payoutData.amount,
      payoutStatus: payoutData.payoutStatus,
      paidOn: payoutData.paidOn,
      paymentReference: payoutData.paymentReference,
      notes: payoutData.notes,
    });

    agent.markModified("commissionPayouts");

    await agent.save();

    return mapAgentForUi(await populateAgentQuery(Agent.findById(agent._id)));
  }

  async updateCommissionPayout(agentId, payoutId, updateData = {}) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !normalizedAgentId ||
      !mongoose.Types.ObjectId.isValid(normalizedAgentId)
    ) {
      throw new AppError("Invalid agent id", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(payoutId)) {
      throw new AppError("Invalid payout id", 400);
    }

    const agent = await Agent.findOne({
      _id: normalizedAgentId,
      "commissionPayouts.payoutId": payoutId,
    });

    if (!agent) {
      throw new AppError("Commission payout not found", 404);
    }

    const payout = agent.commissionPayouts.find(
      (item) => item.payoutId.toString() === payoutId.toString()
    );

    if (!payout) {
      throw new AppError("Commission payout not found", 404);
    }

    Object.assign(payout, updateData);

    if (updateData.payoutStatus === "paid" && !updateData.paidOn) {
      payout.paidOn = new Date();
    }

    agent.markModified("commissionPayouts");
    await agent.save();

    return mapAgentForUi(await populateAgentQuery(Agent.findById(agent._id)));
  }

  async addKycDocument(agentId, documentData) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !normalizedAgentId ||
      !mongoose.Types.ObjectId.isValid(normalizedAgentId)
    ) {
      throw new AppError("Invalid agent id", 400);
    }

    if (!documentData || !documentData.fileName || !documentData.fileUrl) {
      throw new AppError("KYC document fileName and fileUrl are required", 400);
    }

    const agent = await Agent.findById(normalizedAgentId);

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    agent.kycDocuments.push({
      documentType: documentData.documentType,
      fileName: documentData.fileName,
      fileUrl: documentData.fileUrl,
      notes: documentData.notes,
    });

    agent.markModified("kycDocuments");
    await agent.save();

    return mapAgentForUi(await populateAgentQuery(Agent.findById(agent._id)));
  }

  async removeKycDocument(agentId, documentId) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !normalizedAgentId ||
      !mongoose.Types.ObjectId.isValid(normalizedAgentId)
    ) {
      throw new AppError("Invalid agent id", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(documentId)) {
      throw new AppError("Invalid document id", 400);
    }

    const agent = await Agent.findById(normalizedAgentId);

    if (!agent) {
      throw new AppError("Agent not found", 404);
    }

    const initialLength = agent.kycDocuments.length;
    agent.kycDocuments = agent.kycDocuments.filter(
      (doc) => doc.documentId.toString() !== documentId.toString()
    );

    if (agent.kycDocuments.length === initialLength) {
      throw new AppError("KYC document not found", 404);
    }

    agent.markModified("kycDocuments");
    await agent.save();

    return mapAgentForUi(await populateAgentQuery(Agent.findById(agent._id)));
  }
}

module.exports = new AgentService();

