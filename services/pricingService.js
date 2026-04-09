// services/pricingService.js
const CustomerRate = require("../models/CustomerRate");
const SKU = require("../models/SKU");
const AppError = require("../utils/AppError");

class PricingService {
  /**
   * Lightweight sales pricing calculation given a 44" base rate and dimensions.
   * Mirrors the UI logic: 44" benchmark → derived rate per roll → line total.
   * Tax is handled by the caller after this returns.
   */
  calculateSalesPricing(
    baseRate44,
    widthInches,
    lengthMetersPerRoll,
    qtyRolls,
    overrideRatePerRoll
  ) {
    const width = Number(widthInches) || 0;
    const qty = Number(qtyRolls) || 0;
    const length = Number(lengthMetersPerRoll) || 0;
    const base = Number(baseRate44) || 0;

    const derivedRatePerRoll = width > 0 ? Math.round(base * (width / 44)) : 0;
    const finalRatePerRoll =
      overrideRatePerRoll !== undefined && overrideRatePerRoll !== null
        ? Number(overrideRatePerRoll) || 0
        : derivedRatePerRoll;

    const lineTotal = finalRatePerRoll * qty;

    return {
      derivedRatePerRoll,
      finalRatePerRoll,
      lineTotal,
      totalMeters: length * qty,
    };
  }

  /**
   * Look up the customer-specific rate for a given SKU, then compute pricing.
   * CustomerRate is keyed by (customerId, skuId) — width is already baked into
   * the SKU, so no 44" benchmark derivation is needed here.
   */
  async calculatePrice(customerId, skuId, quantityRolls, lengthMeters = 1000) {
    // CustomerRate.getActiveRate(customerId, skuId) — see CustomerRate.js static
    const rate = await CustomerRate.getActiveRate(customerId, skuId);

    if (!rate) {
      throw new AppError(
        "No rate defined for this customer-SKU combination",
        404
      );
    }

    // Rate stored per roll (not per meter) — CustomerRate.baseRate is the roll rate
    const ratePerRoll = Number(rate.baseRate);
    const subtotal = ratePerRoll * quantityRolls;

    // Get SKU → Product for tax rate
    const sku = await SKU.findById(skuId).populate({
      path: "productId",
      select: "taxRate",
    });
    const taxRate = sku?.productId?.taxRate || 18;
    const taxAmount = Math.round(((subtotal * taxRate) / 100) * 100) / 100;
    const total = subtotal + taxAmount;

    return {
      baseRate: ratePerRoll,
      skuId,
      skuid: skuId,
      customerId,
      customerid: customerId,
      quantityRolls,
      ratePerRoll,
      subtotal,
      taxRate,
      taxAmount,
      total,
      rateId: rate._id,
    };
  }

  /**
   * Calculate rate for any width based on 44" benchmark (used for ad-hoc pricing).
   */
  calculateWidthRate(baseRate44, widthInches) {
    return Math.round(Number(baseRate44) * (Number(widthInches) / 44));
  }

  /**
   * Apply override rate with deviation validation.
   */
  async applyOverrideRate(originalPrice, overrideRate44, widthInches, reason, userId) {
    const overrideRatePerRoll = this.calculateWidthRate(overrideRate44, widthInches);
    const originalRatePerRoll = originalPrice.ratePerRoll;

    const deviation = Math.abs(overrideRatePerRoll - originalRatePerRoll) / originalRatePerRoll;
    const deviationPercent = Math.round(deviation * 100);
    const requiresApproval = deviation > 0.05;

    return {
      originalRate44: originalPrice.baseRate44,
      overrideRate44,
      originalRatePerRoll,
      overrideRatePerRoll,
      deviation: deviationPercent,
      requiresApproval,
      reason,
      approvedBy: requiresApproval ? null : userId,
      status: requiresApproval ? "PENDING_APPROVAL" : "APPROVED",
    };
  }

  /**
   * Get price matrix for a customer — all active SKU rates.
   * CustomerRate is SKU-level; we populate the SKU → Product chain for display names.
   */
  async getCustomerPriceMatrix(customerId) {
    const rates = await CustomerRate.find({
      customerId,
      active: true,
      validTo: null,
    }).populate({
      path: "skuId",
      select: "skuCode widthInches productId",
      populate: {
        path: "productId",
        select: "productCode productAlias taxRate",
        populate: [
          { path: "categoryId", select: "name" },
          { path: "gsmId", select: "name value" },
          { path: "qualityId", select: "name" },
        ],
      },
    });

    return rates.map((rate) => {
      const sku = rate.skuId;
      const product = sku?.productId;
      return {
        rateId: rate._id,
        customerId: rate.customerId,
        customerid: rate.customerId,
        skuId: sku?._id,
        skuid: sku?._id,
        skuCode: sku?.skuCode,
        widthInches: sku?.widthInches,
        productName: product?.productAlias || product?.productCode || "",
        categoryName: product?.categoryId?.name || "",
        gsm: product?.gsmId?.value?.toString() || product?.gsmId?.name || "",
        qualityName: product?.qualityId?.name || "",
        baseRate: rate.baseRate,
        validFrom: rate.validFrom,
        isSpecialRate: rate.isSpecialRate,
      };
    });
  }

  /**
   * Bulk rate revision — applies a percentage or flat adjustment to all active
   * SKU rates for a customer. Creates a new rate record and expires the old one.
   * All fields reference CustomerRate schema: skuId + baseRate.
   */
  async bulkRateRevision(customerId, revisionType, value, skuIds = null) {
    const query = { customerId, active: true, validTo: null };
    if (skuIds && skuIds.length) {
      query.skuId = { $in: skuIds };
    }

    const rates = await CustomerRate.find(query);
    const updates = [];

    for (const rate of rates) {
      const currentRate = Number(rate.baseRate);
      let newBaseRate;

      if (revisionType === "PERCENTAGE") {
        newBaseRate = Math.round(currentRate * (1 + value / 100));
      } else if (revisionType === "FLAT") {
        newBaseRate = currentRate + value;
      } else {
        throw new AppError("Invalid revision type. Use PERCENTAGE or FLAT.", 400);
      }

      if (newBaseRate < 0) newBaseRate = 0;

      updates.push({
        skuId: rate.skuId,
        oldRate: currentRate,
        newRate: newBaseRate,
        change: newBaseRate - currentRate,
        changePercent: currentRate > 0
          ? Math.round(((newBaseRate - currentRate) / currentRate) * 100)
          : 0,
      });

      // Expire old rate
      rate.active = false;
      rate.validTo = new Date();
      await rate.save();

      // Create new rate with correct field names
      await CustomerRate.create({
        customerId,
        skuId: rate.skuId,
        baseRate: newBaseRate,
        validFrom: new Date(),
        validTo: null,
        active: true,
        notes: `Bulk revision: ${revisionType} ${value}`,
      });
    }

    return updates;
  }

  /**
   * Calculate deal rate for special orders with a flat discount across all items.
   */
  async calculateDealRate(customerId, items, dealDiscount) {
    const pricing = [];
    let totalOriginal = 0;
    let totalDeal = 0;

    for (const item of items) {
      const originalPrice = await this.calculatePrice(
        customerId,
        item.skuId,
        item.quantity
      );

      const dealRatePerRoll = Math.round(
        originalPrice.ratePerRoll * (1 - dealDiscount / 100)
      );
      const dealSubtotal = dealRatePerRoll * item.quantity;

      pricing.push({
        ...item,
        originalRatePerRoll: originalPrice.ratePerRoll,
        dealRatePerRoll,
        originalSubtotal: originalPrice.subtotal,
        dealSubtotal,
        savings: originalPrice.subtotal - dealSubtotal,
      });

      totalOriginal += originalPrice.subtotal;
      totalDeal += dealSubtotal;
    }

    return {
      items: pricing,
      totalOriginal,
      totalDeal,
      totalSavings: totalOriginal - totalDeal,
      savingsPercent:
        totalOriginal > 0
          ? Math.round(((totalOriginal - totalDeal) / totalOriginal) * 100)
          : 0,
      dealDiscount,
    };
  }
}

module.exports = new PricingService();
