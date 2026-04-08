const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");
const SKU = require("../models/SKU");
const numberingService = require("../services/numberingService");
const pricingService = require("../services/pricingService");
const { autoAllocateForLine } = require("../services/allocationService");
const { STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

// ─── Shared line builder ────────────────────────────────────────────────────

/**
 * Build a fully-processed line object for storage.
 * Runs the allocation algorithm against live inventory and attaches the result.
 *
 * @param {Object}  line          - Raw line from request body
 * @param {Object}  sku           - Populated Mongoose SKU document (productId.categoryId / gsmId / qualityId)
 * @param {number}  lineTotal     - Tax-EXCLUSIVE line value
 * @param {number}  lineTax       - Tax amount for this line
 * @param {boolean} [runAllocation=true] - Set false in calculatePricing (dry run)
 */
async function buildProcessedLine(line, sku, lineTotal, lineTax = 0, runAllocation = true) {
  const effectiveTotalMeters =
    line.totalMeters != null && line.totalMeters > 0
      ? Number(line.totalMeters)
      : Number(line.qtyRolls) * Number(line.lengthMetersPerRoll);

  // ── Resolve denormalized product attributes from populated SKU ─────────
  // SKU model only stores productId; category/gsm/quality come from Product refs.
  const product = sku.productId;
  const categoryName =
    product?.categoryId?.name || product?.category?.name || line.categoryName || "";
  const qualityName =
    product?.qualityId?.name || product?.quality?.name || line.qualityName || "";
  // GSM can be stored as numeric value or as name string
  const gsmRaw = product?.gsmId;
  const gsm =
    (typeof gsmRaw === "object"
      ? gsmRaw?.value?.toString() || gsmRaw?.name
      : gsmRaw?.toString()) ||
    line.gsm ||
    "";

  // ── Auto-allocation against live inventory ─────────────────────────────
  let allocationData = {
    allocation: [],
    allocationStatus: "NOT_CHECKED",
    totalAllocatedMeters: 0,
    remainingMeters: effectiveTotalMeters,
  };

  if (runAllocation && effectiveTotalMeters > 0 && line.skuId) {
    try {
      const result = await autoAllocateForLine(line.skuId, effectiveTotalMeters);
      if (result) {
        allocationData = {
          allocation: result.rollDetails,
          allocationStatus: result.status,
          totalAllocatedMeters: result.totalAllocatedMeters,
          remainingMeters: result.remainingMeters,
        };
      }
    } catch (err) {
      // Allocation failure must never block order save
      console.error(`[allocation] Failed for SKU ${line.skuId}:`, err.message);
    }
  }

  return {
    skuId: line.skuId,
    categoryName,
    gsm,
    qualityName,
    widthInches: sku.widthInches,
    lengthMetersPerRoll: line.lengthMetersPerRoll,
    qtyRolls: line.qtyRolls,
    totalMeters: effectiveTotalMeters,
    bifurcations: Array.isArray(line.bifurcations) ? line.bifurcations : [],
    ...allocationData,
    overrideRatePerRoll: line.overrideRatePerRoll,
    // lineTotal is tax-EXCLUSIVE; lineTax and lineGrossTotal allow UI to show both
    lineTotal,
    lineTax,
    lineGrossTotal: lineTotal + lineTax,
  };
}

// ─── Controllers ────────────────────────────────────────────────────────────

// Get all sales orders
const getSalesOrders = handleAsyncErrors(async (req, res) => {
  const { status, customerId, dateFrom, dateTo } = req.query;

  const filter = {};
  if (status) {
    const statusArray = Array.isArray(status)
      ? status
      : String(status)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    filter.status =
      statusArray.length > 1 ? { $in: statusArray } : statusArray[0];
  }
  if (customerId) filter.customerId = customerId;
  if (dateFrom || dateTo) {
    filter.date = {};
    if (dateFrom) filter.date.$gte = new Date(dateFrom);
    if (dateTo) filter.date.$lte = new Date(dateTo);
  }

  const salesOrders = await SalesOrder.find(filter)
    .populate({
      path: "customerId",
      select: "companyName customerCode",
      populate: { path: "customerGroupId", select: "name code" },
    })
    .populate({
      path: "lines.skuId",
      select: "skuCode categoryName gsm qualityName widthInches productId",
      populate: {
        path: "productId",
        populate: [
          { path: "categoryId", select: "name" },
          { path: "gsmId", select: "name value" },
          { path: "qualityId", select: "name" },
        ],
      },
    })
    .sort({ createdAt: -1 });

  res.json({
    success: true,
    count: salesOrders.length,
    data: salesOrders,
  });
});

// Get single sales order
const getSalesOrder = handleAsyncErrors(async (req, res) => {
  const salesOrder = await SalesOrder.findById(req.params.id)
    .populate({
      path: "customerId",
      select: "companyName customerCode creditPolicy baseRate44",
      populate: { path: "customerGroupId", select: "name code" },
    })
    .populate({
      path: "lines.skuId",
      select: "skuCode categoryName gsm qualityName widthInches productId",
      populate: {
        path: "productId",
        populate: [
          { path: "categoryId", select: "name" },
          { path: "gsmId", select: "name value" },
          { path: "qualityId", select: "name" },
        ],
      },
    });

  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({
    success: true,
    data: salesOrder,
  });
});

// Create sales order with pricing calculation
const createSalesOrder = handleAsyncErrors(async (req, res) => {
  const { customerId, lines, notes, discountPercent = 0, date, dueDays } = req.body;

  // Verify customer exists and is not blocked
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (customer.creditPolicy?.isBlocked) {
    throw new AppError("Customer is blocked", 400, "CUSTOMER_BLOCKED");
  }

  // Generate SO number
  const soNumber = await numberingService.generateNumber("SO", SalesOrder);

  // Process lines with pricing calculation
  let subtotal = 0;
  let taxAmount = 0;

  const processedLines = [];

  for (const line of lines) {
    // Populate productId so buildProcessedLine can derive categoryName / gsm / qualityName
    const sku = await SKU.findById(line.skuId).populate({
      path: "productId",
      populate: [
        { path: "categoryId", select: "name" },
        { path: "gsmId", select: "name value" },
        { path: "qualityId", select: "name" },
      ],
    });
    if (!sku) {
      throw new AppError(`SKU not found: ${line.skuId}`, 404, "RESOURCE_NOT_FOUND");
    }

    const pricing = pricingService.calculateSalesPricing(
      customer.baseRate44,
      sku.widthInches,
      line.lengthMetersPerRoll,
      line.qtyRolls,
      line.overrideRatePerRoll
    );

    const lineTotal = pricing.lineTotal;
    // taxRate lives on Product, fall back to SKU taxRate if available
    const taxRate = sku.productId?.taxRate ?? sku.taxRate ?? 0;
    const lineTax = lineTotal * (taxRate / 100);

    subtotal += lineTotal;
    taxAmount += lineTax;

    processedLines.push(await buildProcessedLine(line, sku, lineTotal, lineTax));
  }

  // Populate customerGroupId if it exists
  const customerWithGroup = await Customer.findById(customerId).populate(
    "customerGroupId",
    "name code"
  );

  const discountAmount = (subtotal * (Number(discountPercent) || 0)) / 100;

  const defaultDueDays =
    (customer.creditPolicy?.creditDays || 0) +
    (customer.creditPolicy?.graceDays || 0);

  const salesOrder = await SalesOrder.create({
    soNumber,
    customerId,
    customerName: customer.companyName,
    customerGroup:
      customerWithGroup.customerGroupId?.name ||
      customerWithGroup.group ||
      null,
    date: date ? new Date(date) : undefined,
    lines: processedLines,
    subtotal,
    discountPercent: Number(discountPercent) || 0,
    discountAmount,
    taxAmount,
    total: subtotal - discountAmount + taxAmount,
    dueDays: dueDays != null ? Number(dueDays) : defaultDueDays,
    creditCheckPassed: false, // Will be updated on confirmation
    notes,
    createdBy: req.user ? req.user._id : undefined,
  });

  const populatedOrder = await SalesOrder.findById(salesOrder._id)
    .populate({
      path: "customerId",
      select: "companyName customerCode",
      populate: { path: "customerGroupId", select: "name code" },
    })
    .populate("lines.skuId", "skuCode categoryName gsm qualityName widthInches");

  res.status(201).json({
    success: true,
    data: populatedOrder,
  });
});

// Update sales order (draft only)
const updateSalesOrder = handleAsyncErrors(async (req, res) => {
  const { customerId, lines = [], notes, discountPercent = 0, date, dueDays } =
    req.body;
  const salesOrder = await SalesOrder.findById(req.params.id);

  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (salesOrder.status !== STATUS.DRAFT) {
    throw new AppError(
      "Only draft sales orders can be updated",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  let subtotal = 0;
  let taxAmount = 0;
  const processedLines = [];

  for (const line of lines) {
    const sku = await SKU.findById(line.skuId).populate({
      path: "productId",
      populate: [
        { path: "categoryId", select: "name" },
        { path: "gsmId", select: "name value" },
        { path: "qualityId", select: "name" },
      ],
    });
    if (!sku) {
      throw new AppError(`SKU not found: ${line.skuId}`, 404, "RESOURCE_NOT_FOUND");
    }

    const pricing = pricingService.calculateSalesPricing(
      customer.baseRate44,
      sku.widthInches,
      line.lengthMetersPerRoll,
      line.qtyRolls,
      line.overrideRatePerRoll
    );

    const lineTotal = pricing.lineTotal;
    const taxRate = sku.productId?.taxRate ?? sku.taxRate ?? 0;
    const lineTax = lineTotal * (taxRate / 100);

    subtotal += lineTotal;
    taxAmount += lineTax;

    processedLines.push(await buildProcessedLine(line, sku, lineTotal, lineTax));
  }

  const discountAmount = (subtotal * (Number(discountPercent) || 0)) / 100;

  const defaultDueDays =
    (customer.creditPolicy?.creditDays || 0) +
    (customer.creditPolicy?.graceDays || 0);

  salesOrder.customerId = customerId;
  salesOrder.customerName = customer.companyName;
  salesOrder.date = date ? new Date(date) : salesOrder.date;
  salesOrder.lines = processedLines;
  salesOrder.subtotal = subtotal;
  salesOrder.discountPercent = Number(discountPercent) || 0;
  salesOrder.discountAmount = discountAmount;
  salesOrder.taxAmount = taxAmount;
  salesOrder.total = subtotal - discountAmount + taxAmount;
  salesOrder.dueDays = dueDays != null ? Number(dueDays) : (salesOrder.dueDays ?? defaultDueDays);
  salesOrder.notes = notes;
  salesOrder.creditCheckNotes = req.body.creditCheckNotes;
  salesOrder.creditCheckPassed =
    req.body.creditCheckPassed ?? salesOrder.creditCheckPassed;

  await salesOrder.save();

  const populatedOrder = await SalesOrder.findById(salesOrder._id)
    .populate({
      path: "customerId",
      select: "companyName customerCode",
      populate: { path: "customerGroupId", select: "name code" },
    })
    .populate({
      path: "lines.skuId",
      select: "skuCode categoryName gsm qualityName widthInches productId",
      populate: {
        path: "productId",
        populate: [
          { path: "categoryId", select: "name" },
          { path: "gsmId", select: "name value" },
          { path: "qualityId", select: "name" },
        ],
      },
    });

  res.json({
    success: true,
    data: populatedOrder,
  });
});

// Confirm sales order with credit check
const confirmSalesOrder = handleAsyncErrors(async (req, res) => {
  const salesOrder = await SalesOrder.findById(req.params.id);

  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (salesOrder.status !== "Draft") {
    throw new AppError("Only draft sales orders can be confirmed", 400, "INVALID_STATE_TRANSITION");
  }

  // Credit check: compare SO total against available credit limit
  const customer = await Customer.findById(salesOrder.customerId);
  let creditCheckPassed = true;
  let creditCheckNotes = "";

  if (customer && customer.creditPolicy) {
    const policy = customer.creditPolicy;

    if (policy.isBlocked) {
      throw new AppError(
        "Customer is blocked — cannot confirm order",
        400,
        "CUSTOMER_BLOCKED"
      );
    }

    const creditLimit = Number(policy.creditLimit) || 0;
    if (creditLimit > 0) {
      // Count outstanding value from other non-cancelled/closed SOs
      const outstandingSOs = await SalesOrder.aggregate([
        {
          $match: {
            customerId: salesOrder.customerId,
            _id: { $ne: salesOrder._id },
            status: { $in: ["Confirmed", "InProgress"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$total" } } },
      ]);
      const outstandingValue = outstandingSOs[0]?.total || 0;
      const exposureAfterConfirm = outstandingValue + (salesOrder.total || 0);

      if (exposureAfterConfirm > creditLimit) {
        creditCheckPassed = false;
        creditCheckNotes = `Credit limit ₹${creditLimit.toLocaleString("en-IN")} would be exceeded. Current exposure: ₹${outstandingValue.toLocaleString("en-IN")}, this order: ₹${(salesOrder.total || 0).toLocaleString("en-IN")}.`;
      }
    }
  }

  salesOrder.status = "Confirmed";
  salesOrder.creditCheckPassed = creditCheckPassed;
  salesOrder.creditCheckNotes = creditCheckNotes || salesOrder.creditCheckNotes;
  salesOrder.confirmedBy = req.user ? req.user._id : undefined;
  salesOrder.confirmedAt = new Date();
  await salesOrder.save();

  res.json({
    success: true,
    data: salesOrder,
  });
});

// Cancel sales order
const cancelSalesOrder = handleAsyncErrors(async (req, res) => {
  const salesOrder = await SalesOrder.findById(req.params.id);

  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (salesOrder.status === STATUS.CANCELLED) {
    return res.json({ success: true, data: salesOrder });
  }

  salesOrder.status = STATUS.CANCELLED;
  salesOrder.onHoldReason = req.body?.reason;
  await salesOrder.save();

  res.json({
    success: true,
    data: salesOrder,
  });
});

// Put sales order on hold
const holdSalesOrder = handleAsyncErrors(async (req, res) => {
  const salesOrder = await SalesOrder.findById(req.params.id);

  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  salesOrder.status = STATUS.ON_HOLD;
  salesOrder.onHoldReason = req.body?.reason;
  await salesOrder.save();

  res.json({
    success: true,
    data: salesOrder,
  });
});

// Close sales order
const closeSalesOrder = handleAsyncErrors(async (req, res) => {
  const salesOrder = await SalesOrder.findById(req.params.id);

  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  salesOrder.status = STATUS.CLOSED;
  await salesOrder.save();

  res.json({
    success: true,
    data: salesOrder,
  });
});

// Calculate pricing for a sales order
const calculatePricing = handleAsyncErrors(async (req, res) => {
  const { customerId, lines } = req.body;

  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }

  const processedLines = [];

  for (const line of lines) {
    const sku = await SKU.findById(line.skuId);
    if (!sku) {
      throw new AppError(`SKU not found: ${line.skuId}`, 404, "RESOURCE_NOT_FOUND");
    }

    const pricing = pricingService.calculateSalesPricing(
      customer.baseRate44,
      sku.widthInches,
      line.lengthMetersPerRoll,
      line.qtyRolls,
      line.overrideRatePerRoll
    );

    // calculatePricing is a dry-run — skip inventory allocation
    const processedLine = await buildProcessedLine(line, sku, pricing.lineTotal, false);
    processedLines.push({ ...processedLine, requiresApproval: pricing.requiresApproval });
  }

  res.json({
    success: true,
    data: {
      customerBaseRate44: customer.baseRate44,
      lines: processedLines,
    },
  });
});

/**
 * Preview allocation for one or more lines WITHOUT saving anything.
 *
 * POST /sales-orders/preview-allocation
 * Body: { lines: [{ skuId, totalMeters }] }
 *
 * Useful for the frontend bifurcation dialog — the UI can call this endpoint
 * when the user opens the bifurcation modal to get an inventory-based suggestion.
 */
const previewAllocation = handleAsyncErrors(async (req, res) => {
  const { lines } = req.body;

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError("lines array is required", 400, "VALIDATION_ERROR");
  }

  const results = await Promise.all(
    lines.map(async (line) => {
      if (!line.skuId || !line.totalMeters) {
        return {
          skuId: line.skuId,
          totalMeters: line.totalMeters,
          error: "skuId and totalMeters are required",
        };
      }

      const result = await autoAllocateForLine(line.skuId, Number(line.totalMeters));

      return {
        skuId: line.skuId,
        totalMeters: Number(line.totalMeters),
        ...result,
      };
    })
  );

  res.json({ success: true, data: results });
});

module.exports = {
  getSalesOrders,
  getSalesOrder,
  createSalesOrder,
  updateSalesOrder,
  confirmSalesOrder,
  cancelSalesOrder,
  holdSalesOrder,
  closeSalesOrder,
  calculatePricing,
  previewAllocation,
};
