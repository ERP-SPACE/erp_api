// services/pricingService.js
const BaseRate = require("../models/BaseRate");
const SKU = require("../models/SKU");
const AppError = require("../utils/AppError");

class PricingService {
  /**
   * Lightweight sales pricing calculation given a 44" base rate and dimensions.
   * Mirrors the UI logic: 44" benchmark → derived rate for selected width → line total.
   * Tax is handled by the caller after this returns.
   */
  calculateSalesPricing(
    benchmarkRate44,
    widthInches,
    lengthMetersPerRoll,
    qtyRolls,
    overrideRatePerRoll
  ) {
    const width = Number(widthInches) || 0;
    const qty = Number(qtyRolls) || 0;
    const length = Number(lengthMetersPerRoll) || 0;
    const base = Number(benchmarkRate44) || 0;

    // UI behavior: keep 2 decimals for width-derived rate
    const derivedRate =
      width > 0
        ? Math.round((base * (width / 44) + Number.EPSILON) * 100) / 100
        : 0;
    const finalRate =
      overrideRatePerRoll !== undefined && overrideRatePerRoll !== null
        ? Number(overrideRatePerRoll) || 0
        : derivedRate;

    const totalMeters = length * qty;
    const lineTotal = totalMeters * finalRate;

    return {
      derivedRate,
      finalRate,
      lineTotal,
      totalMeters,
    };
  }

  /**
   * Look up the customer-specific 44" benchmark (BaseRate with customerId), then compute pricing.
   * Keyed by (customerId, productId) on BaseRate.
   */
  async calculatePrice(customerId, skuId, quantityRolls, lengthMeters = 1000) {
    // Resolve SKU → Product first (pricing requests are still SKU-based)
    const sku = await SKU.findById(skuId).populate({
      path: "productId",
      select: "taxRate",
    });
    const productId = sku?.productId?._id || sku?.productId || null;

    if (!productId) {
      throw new AppError("Invalid SKU/product mapping for pricing", 400);
    }

    const rate = await BaseRate.findOne({ customerId, productId });

    if (!rate) {
      throw new AppError(
        "No rate defined for this customer-product combination",
        404
      );
    }

    // Rate stored per roll (not per meter) — BaseRate.rate is the roll rate for the benchmark width
    const ratePerRoll = Number(rate.rate);
    const subtotal = ratePerRoll * quantityRolls;

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
  calculateWidthRate(benchmarkRate44, widthInches) {
    return Math.round(Number(benchmarkRate44) * (Number(widthInches) / 44));
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
      originalRate44: originalPrice.benchmarkRate44,
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
   * Get price matrix for a customer — all product benchmark rates.
   */
  async getCustomerPriceMatrix(customerId) {
    const rates = await BaseRate.find({
      customerId,
    }).populate({
      path: "productId",
      select: "productCode productAlias taxRate categoryId gsmId qualityId",
      populate: [
        { path: "categoryId", select: "name" },
        { path: "gsmId", select: "name value" },
        { path: "qualityId", select: "name" },
      ],
    });

    return rates.map((rate) => {
      const product = rate.productId;
      return {
        rateId: rate._id,
        customerId: rate.customerId,
        customerid: rate.customerId,
        productId: product?._id,
        productid: product?._id,
        productName: product?.productAlias || product?.productCode || "",
        categoryName: product?.categoryId?.name || "",
        gsm: product?.gsmId?.value?.toString() || product?.gsmId?.name || "",
        qualityName: product?.qualityId?.name || "",
        baseRate: rate.rate,
        validFrom: rate.updatedAt || rate.createdAt,
        isSpecialRate: false,
      };
    });
  }

  /**
   * Bulk rate revision — applies a percentage or flat adjustment to BaseRate rows for a customer.
   */
  async bulkRateRevision(customerId, revisionType, value, productIds = null) {
    const RateHistory = require("../models/RateHistory");
    const query = { customerId };
    if (productIds && productIds.length) {
      query.productId = { $in: productIds };
    }

    const rates = await BaseRate.find(query);
    const updates = [];

    for (const rate of rates) {
      const currentRate = Number(rate.rate);
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
        productId: rate.productId,
        oldRate: currentRate,
        newRate: newBaseRate,
        change: newBaseRate - currentRate,
        changePercent: currentRate > 0
          ? Math.round(((newBaseRate - currentRate) / currentRate) * 100)
          : 0,
      });

      await RateHistory.create({
        baseRateId: rate._id,
        productId: rate.productId,
        supplierId: null,
        agentId: null,
        customerId: rate.customerId,
        previousRate: rate.rate,
      });

      rate.rate = newBaseRate;
      await rate.save();
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
