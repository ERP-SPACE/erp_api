// services/customerService.js
const Customer = require("../models/Customer");
const CustomerRate = require("../models/CustomerRate");
const Agent = require("../models/Agent");
const AppError = require("../utils/AppError");
const mongoose = require("mongoose");

const validateAgentId = async (agentId) => {
  if (!agentId) return null;

  if (!mongoose.Types.ObjectId.isValid(agentId)) {
    throw new AppError("Invalid agent id", 400);
  }

  const agent = await Agent.findById(agentId);
  if (!agent) {
    throw new AppError("Agent not found", 404);
  }

  return agent._id;
};

const syncAgentCustomerMapping = async (
  customerId,
  previousAgentId,
  nextAgentId
) => {
  const prev = previousAgentId ? previousAgentId.toString() : null;
  const next = nextAgentId ? nextAgentId.toString() : null;

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
      if (typeof id === "object" && id !== null) {
        if (id._id) return id._id.toString();
        if (id.toString) return id.toString();
      }
      return id;
    });

  return [...new Set(normalized)];
};

class CustomerService {
  async createCustomer(data) {
    // Check for duplicate GSTIN if provided
    if (data.gstin) {
      const existingCustomer = await Customer.findOne({ gstin: data.gstin });
      if (existingCustomer) {
        throw new AppError("Customer with this GSTIN already exists", 400);
      }
    }

    // Ensure at least one primary contact
    if (data.contactPersons && data.contactPersons.length > 0) {
      const hasPrimary = data.contactPersons.some((cp) => cp.isPrimary);
      if (!hasPrimary) {
        data.contactPersons[0].isPrimary = true;
      }
    }

    // Set default shipping address if not provided
    if (!data.address.shipping || data.address.shipping.length === 0) {
      data.address.shipping = [
        {
          label: "Default",
          ...data.address.billing,
          isDefault: true,
        },
      ];
    }

    const normalizedGroups = normalizeCustomerGroupIds(
      data.customerGroupIds,
      data.customerGroupId
    );

    if (!normalizedGroups.length) {
      throw new AppError("At least one customer group is required", 400);
    }

    data.customerGroupIds = normalizedGroups;
    data.customerGroupId = normalizedGroups[0];

    const normalizedAgentId = await validateAgentId(data.agentId);
    data.agentId = normalizedAgentId;

    const customer = await Customer.create(data);
    await syncAgentCustomerMapping(customer._id, null, normalizedAgentId);
    return customer;
  }

  async getAllCustomers(filters = {}, pagination = {}) {
    const query = {};

    if (filters.active !== undefined) {
      query.active = filters.active;
    }

    if (filters.group) {
      query.group = filters.group;
    }

    if (filters.isBlocked !== undefined) {
      query["creditPolicy.isBlocked"] = filters.isBlocked;
    }

    if (filters.search) {
      query.$text = { $search: filters.search };
    }

    const page = parseInt(pagination.page) || 1;
    const limit = parseInt(pagination.limit) || 20;
    const skip = (page - 1) * limit;

    const [customers, total] = await Promise.all([
      Customer.find(query).sort({ companyName: 1 }).skip(skip).limit(limit),
      Customer.countDocuments(query),
    ]);

    return {
      customers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getCustomerById(id) {
    const customer = await Customer.findById(id);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    // Get customer rates
    const rates = await CustomerRate.find({
      customerId: id,
      active: true,
    }).populate({
      path: "skuId",
      select: "skuCode skuAlias widthInches productId",
      populate: {
        path: "productId",
        select: "productCode productAlias taxRate",
      },
    });

    return { customer, rates };
  }

  async updateCustomer(id, updateData) {
    // Don't allow changing GSTIN or code
    delete updateData.gstin;
    delete updateData.customerCode;

    const existingCustomer = await Customer.findById(id);

    if (!existingCustomer) {
      throw new AppError("Customer not found", 404);
    }

    const previousAgentId = existingCustomer.agentId;

    if (
      Object.prototype.hasOwnProperty.call(updateData, "customerGroupIds") ||
      Object.prototype.hasOwnProperty.call(updateData, "customerGroupId")
    ) {
      const normalizedGroups = normalizeCustomerGroupIds(
        updateData.customerGroupIds,
        updateData.customerGroupId
      );

      if (!normalizedGroups.length) {
        throw new AppError("At least one customer group is required", 400);
      }

      updateData.customerGroupIds = normalizedGroups;
      updateData.customerGroupId = normalizedGroups[0];
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "agentId")) {
      updateData.agentId = await validateAgentId(updateData.agentId);
    }

    const customer = await Customer.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    await syncAgentCustomerMapping(
      customer._id,
      previousAgentId,
      customer.agentId
    );

    return customer;
  }

  async updateCreditPolicy(customerId, creditPolicy) {
    const customer = await Customer.findById(customerId);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    customer.creditPolicy = {
      ...customer.creditPolicy.toObject(),
      ...creditPolicy,
    };

    await customer.save();
    return customer;
  }

  async blockCustomer(customerId, reason, automatic = false) {
    const customer = await Customer.findById(customerId);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    customer.creditPolicy.isBlocked = true;
    customer.creditPolicy.blockReason = reason;
    customer.creditPolicy.blockedAt = new Date();

    await customer.save();

    // Send WhatsApp notification if enabled
    if (
      customer.whatsappConfig.enabled &&
      customer.whatsappConfig.notifications.payment
    ) {
      // Queue WhatsApp message
      await this.queueWhatsAppMessage(customer, "CREDIT_BLOCK", { reason });
    }

    return customer;
  }

  async unblockCustomer(customerId, userId, notes) {
    const customer = await Customer.findById(customerId);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    customer.creditPolicy.isBlocked = false;
    customer.creditPolicy.blockReason = null;
    customer.creditPolicy.unblockedBy = userId;
    customer.notes = notes;

    await customer.save();
    return customer;
  }

  async checkCreditLimit(customerId) {
    const customer = await Customer.findById(customerId);

    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    const { creditPolicy } = customer;

    // Get outstanding amount from invoices
    const SalesInvoice = require("../models/SalesInvoice");
    const outstanding = await SalesInvoice.aggregate([
      {
        $match: {
          customerId: new mongoose.Types.ObjectId(customerId),
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

    const outstandingAmount = outstanding[0]?.total || 0;

    // Get pending order value
    const SalesOrder = require("../models/SalesOrder");
    const pendingOrders = await SalesOrder.aggregate([
      {
        $match: {
          customerId: new mongoose.Types.ObjectId(customerId),
          status: { $in: ["Confirmed", "PartiallyFulfilled"] },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
        },
      },
    ]);

    const pendingAmount = pendingOrders[0]?.total || 0;
    const totalExposure = outstandingAmount + pendingAmount;

    // Check credit rules
    let shouldBlock = false;
    let blockReason = null;

    if (
      creditPolicy.blockRule === "OVER_LIMIT" ||
      creditPolicy.blockRule === "BOTH"
    ) {
      if (totalExposure > creditPolicy.creditLimit) {
        shouldBlock = true;
        blockReason = `Credit limit exceeded. Exposure: ₹${totalExposure}, Limit: ₹${creditPolicy.creditLimit}`;
      }
    }

    if (
      !shouldBlock &&
      (creditPolicy.blockRule === "OVER_DUE" ||
        creditPolicy.blockRule === "BOTH")
    ) {
      // Check for overdue invoices
      const overdueDate = new Date();
      overdueDate.setDate(
        overdueDate.getDate() -
          (creditPolicy.creditDays + creditPolicy.graceDays)
      );

      const overdueInvoices = await SalesInvoice.findOne({
        customerId: customerId,
        status: "Posted",
        paymentStatus: { $ne: "Paid" },
        $or: [
          { dueDate: { $lte: overdueDate } },
          {
            dueDate: { $exists: false },
            siDate: { $lte: overdueDate },
          },
          {
            dueDate: null,
            siDate: { $lte: overdueDate },
          },
        ],
      });

      if (overdueInvoices) {
        shouldBlock = true;
        blockReason = `Invoices overdue beyond grace period`;
      }
    }

    // Update customer exposure
    customer.creditPolicy.currentExposure = totalExposure;

    // Auto-block if needed
    if (shouldBlock && creditPolicy.autoBlock && !creditPolicy.isBlocked) {
      await this.blockCustomer(customerId, blockReason, true);
    }

    await customer.save();

    return {
      customerId,
      creditLimit: creditPolicy.creditLimit,
      currentExposure: totalExposure,
      availableCredit: Math.max(0, creditPolicy.creditLimit - totalExposure),
      isBlocked: customer.creditPolicy.isBlocked,
      blockReason: customer.creditPolicy.blockReason,
      shouldBlock,
      suggestedBlockReason: blockReason,
    };
  }

  async setCustomerRate(customerId, productId, baseRate44, userId, notes) {
    const skuId = productId;
    const baseRate = baseRate44;
    if (!skuId) {
      throw new AppError("skuId is required", 400);
    }
    if (baseRate === undefined || baseRate === null) {
      throw new AppError("baseRate is required", 400);
    }

    // Deactivate existing rate
    await CustomerRate.updateMany(
      {
        customerId,
        skuId,
        active: true,
      },
      {
        active: false,
        validTo: new Date(),
      }
    );

    // Create new rate
    const rate = await CustomerRate.create({
      customerId,
      skuId,
      baseRate,
      approvedBy: userId,
      notes,
      validFrom: new Date(),
      validTo: null,
      active: true,
    });

    return rate;
  }

  async bulkUpdateRates(customerId, rateUpdates, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const results = [];

      for (const update of rateUpdates) {
        const skuId = update.skuId || update.productId;
        const baseRate = update.baseRate ?? update.baseRate44;
        if (!skuId) {
          throw new AppError("Each rate update must include skuId", 400);
        }
        if (baseRate === undefined || baseRate === null) {
          throw new AppError("Each rate update must include baseRate", 400);
        }

        // Deactivate old rate
        await CustomerRate.updateMany(
          {
            customerId,
            skuId,
            active: true,
          },
          {
            active: false,
            validTo: new Date(),
          },
          { session }
        );

        // Create new rate
        const rate = await CustomerRate.create(
          [
            {
              customerId,
              skuId,
              baseRate,
              approvedBy: userId,
              notes: update.notes,
              validFrom: new Date(),
              validTo: null,
              active: true,
            },
          ],
          { session }
        );

        results.push(rate[0]);
      }

      await session.commitTransaction();
      return results;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async getCustomerRateHistory(customerId, productId = null) {
    const query = { customerId };
    if (productId) {
      query.skuId = productId;
    }

    const history = await CustomerRate.find(query)
      .populate({
        path: "skuId",
        select: "skuCode skuAlias widthInches productId",
        populate: {
          path: "productId",
          select: "productCode productAlias taxRate",
        },
      })
      .populate("approvedBy", "name")
      .sort({ createdAt: -1 });

    return history;
  }

  async queueWhatsAppMessage(customer, templateType, data) {
    // This would integrate with WhatsApp service
    // For now, just log
    console.log(
      `WhatsApp message queued for ${customer.customerCode}: ${templateType}`,
      data
    );
  }
}

module.exports = new CustomerService();
