const PurchaseOrder = require("../models/PurchaseOrder");
const Supplier = require("../models/Supplier");
const SKU = require("../models/SKU");
const numberingService = require("../services/numberingService");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");
const { STATUS, PURCHASE_ORDER_STATUS } = require("../config/constants");

// Get all purchase orders
const getPurchaseOrders = handleAsyncErrors(async (req, res) => {
  const { supplierId, dateFrom, dateTo, overdueOnly } = req.query;

  const filter = {};
  if (supplierId) filter.supplierId = supplierId;
  if (dateFrom || dateTo) {
    filter.date = {};
    if (dateFrom) filter.date.$gte = new Date(dateFrom);
    if (dateTo) filter.date.$lte = new Date(dateTo);
  }

  const purchaseOrders = await PurchaseOrder.find(filter)
    .populate("supplierId", "name supplierCode leadTime")
    .sort({ createdAt: -1 });

  const ordersWithTracking = purchaseOrders.map((poDoc) => {
    const poObject = poDoc.toObject ? poDoc.toObject() : poDoc;
    const overdueInfo = buildOverdueInfo(poObject);

    return {
      ...poObject,
      expectedDeliveryDate: overdueInfo.expectedDeliveryDate,
      supplierLeadTime: overdueInfo.supplierLeadTime,
      outstanding: overdueInfo.outstanding,
      overdue: {
        isOverdue: overdueInfo.isOverdue,
        days: overdueInfo.overdueDays,
      },
    };
  });

  const filterOverdue =
    typeof overdueOnly === "string" &&
    ["true", "1", "yes"].includes(overdueOnly.toLowerCase());

  const filteredOrders = filterOverdue
    ? ordersWithTracking.filter((po) => po.overdue?.isOverdue)
    : ordersWithTracking;

  res.json({
    success: true,
    count: filteredOrders.length,
    data: filteredOrders,
  });
});

// Get single purchase order
const getPurchaseOrder = handleAsyncErrors(async (req, res) => {
  const purchaseOrder = await PurchaseOrder.findById(req.params.id)
    .populate("supplierId", "name supplierCode address contactPersons")
    .populate(
      "lines.skuId",
      "skuCode categoryName gsm qualityName widthInches"
    );

  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({
    success: true,
    data: purchaseOrder,
  });
});

const sanitizeNumber = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[₹,$,\s]/g, "");
    const parsed = parseFloat(cleaned);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "object" && typeof value.value === "number") {
    return value.value;
  }
  return Number(value) || 0;
};

const deriveWidthRate = (baseRate44, widthInches) => {
  const base = sanitizeNumber(baseRate44);
  const width = sanitizeNumber(widthInches);
  if (!base || !width) return 0;
  return Math.round(base * (width / 44) * 100) / 100;
};

const normalizeNullableNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = sanitizeNumber(value);
  return n === 0 ? 0 : n;
};

const deriveOrderStatusFromLines = (lines = []) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    return PURCHASE_ORDER_STATUS.DRAFT;
  }

  const completedCount = lines.filter(
    (line = {}) =>
      (line.lineStatus || line.status || "").toLowerCase() === "complete"
  ).length;
  const totalCount = lines.length;

  if (completedCount === totalCount) {
    return PURCHASE_ORDER_STATUS.COMPLETE;
  }

  if (completedCount > 0) {
    return PURCHASE_ORDER_STATUS.PARTIAL;
  }

  return PURCHASE_ORDER_STATUS.PENDING;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const normalizeDateInput = (value) => {
  if (!value) return null;
  const dateValue = new Date(value);
  return Number.isNaN(dateValue.getTime()) ? null : dateValue;
};

const calculateOutstanding = (poDoc = {}) => {
  return (poDoc.lines || []).reduce(
    (acc, line = {}) => {
      const orderedRolls = sanitizeNumber(line.qtyRolls);
      const receivedRolls = sanitizeNumber(line.receivedQty);
      const orderedMeters =
        sanitizeNumber(line.totalMeters) ||
        orderedRolls * sanitizeNumber(line.lengthMetersPerRoll);
      const receivedMeters = sanitizeNumber(line.receivedMeters);

      acc.rolls += Math.max(orderedRolls - receivedRolls, 0);
      acc.meters += Math.max(orderedMeters - receivedMeters, 0);
      return acc;
    },
    { rolls: 0, meters: 0 }
  );
};

const computeExpectedDate = (poDoc = {}, supplierLeadTime = 0) => {
  const provided = normalizeDateInput(poDoc.expectedDeliveryDate);
  if (provided) return provided;

  const baseDate = normalizeDateInput(poDoc.date) || new Date();
  const leadDays =
    typeof supplierLeadTime === "number"
      ? supplierLeadTime
      : Number(supplierLeadTime) || 0;

  if (leadDays <= 0) return baseDate;
  return new Date(baseDate.getTime() + leadDays * DAY_IN_MS);
};

const buildOverdueInfo = (poDoc = {}) => {
  const supplierLeadTime =
    poDoc.supplierLeadTime ||
    poDoc.supplierId?.leadTime ||
    poDoc.supplier?.leadTime ||
    0;

  const expected = computeExpectedDate(poDoc, supplierLeadTime || 7);
  const outstanding = calculateOutstanding(poDoc);
  const now = new Date();

  const isClosed = [
    PURCHASE_ORDER_STATUS.CLOSED,
    PURCHASE_ORDER_STATUS.CANCELLED,
  ].includes(poDoc.poStatus);

  const isOverdue =
    !isClosed &&
    outstanding.rolls > 0 &&
    expected &&
    expected.getTime() < now.getTime();

  const overdueDays = isOverdue
    ? Math.ceil((now.getTime() - expected.getTime()) / DAY_IN_MS)
    : 0;

  return {
    outstanding,
    expectedDeliveryDate: expected,
    isOverdue,
    overdueDays,
    supplierLeadTime: supplierLeadTime || 7,
  };
};

// Create purchase order
const createPurchaseOrder = handleAsyncErrors(async (req, res) => {
  const {
    supplierId,
    lines,
    notes,
    status: requestedStatusLegacy,
    poStatus: requestedPoStatus,
    saveAsDraft,
    expectedDeliveryDate,
    date,
    supplierLeadTime: supplierLeadTimeInput,
  } = req.body;

  // Verify supplier exists
  const supplier = await Supplier.findById(supplierId);
  if (!supplier) {
    throw new AppError("Supplier not found", 404, "RESOURCE_NOT_FOUND");
  }

  // Generate PO number
  const poNumber = await numberingService.generateNumber("PO", PurchaseOrder);

  const orderDate = normalizeDateInput(date) || new Date();
  const normalizedLeadTime = sanitizeNumber(
    supplierLeadTimeInput !== undefined
      ? supplierLeadTimeInput
      : supplier.leadTime || 0
  );
  const effectiveLeadTime = normalizedLeadTime || sanitizeNumber(supplier.leadTime) || 7;

  const computedExpectedDate = normalizeDateInput(expectedDeliveryDate)
    || computeExpectedDate({ date: orderDate }, effectiveLeadTime);

  // Calculate totals
  let subtotal = 0;
  let totalMetersSum = 0;

  const processedLines = (lines || []).map((line = {}) => {
    const qtyRolls = sanitizeNumber(line.qtyRolls);
    const overrideRatePerRoll = normalizeNullableNumber(line.overrideRatePerRoll);
    const baseRate44 = sanitizeNumber(line.baseRate44);
    const derivedRatePerRoll =
      sanitizeNumber(line.derivedRatePerRoll) ||
      deriveWidthRate(baseRate44, line.widthInches);
    const finalRatePerRoll =
      overrideRatePerRoll !== null && overrideRatePerRoll !== undefined
        ? sanitizeNumber(overrideRatePerRoll)
        : derivedRatePerRoll || sanitizeNumber(line.ratePerRoll);
    const ratePerRoll = finalRatePerRoll;
    const lengthMetersPerRoll = sanitizeNumber(line.lengthMetersPerRoll);
    const incomingTotalMeters = sanitizeNumber(line.totalMeters);
    const lineMeters =
      incomingTotalMeters > 0 ? incomingTotalMeters : qtyRolls * lengthMetersPerRoll;
    const lineTotal = lineMeters * ratePerRoll;
    const lineStatus =
      typeof line.lineStatus === "string" && line.lineStatus.trim()
        ? line.lineStatus
        : typeof line.status === "string" && line.status.trim()
        ? line.status
        : "Pending";
    // Extract skuId separately — an empty string must be omitted, not passed to
    // Mongoose, which would throw a CastError trying to coerce "" to ObjectId.
    const { taxRate: _ignoredTaxRate, skuId: rawSkuId, ...restLine } = line || {};
    const skuId = rawSkuId || undefined;

    subtotal += lineTotal;
    totalMetersSum += lineMeters;

    return {
      ...restLine,
      ...(skuId ? { skuId } : {}),
      baseRate44,
      derivedRatePerRoll,
      overrideRatePerRoll,
      qtyRolls,
      ratePerRoll,
      lengthMetersPerRoll,
      totalMeters: lineMeters,
      lineTotal,
      lineStatus,
    };
  });

  // For create:
  // - If saveAsDraft true => Draft + all lines Pending
  // - Else => Pending + all lines Pending
  const headerStatus = saveAsDraft
    ? PURCHASE_ORDER_STATUS.DRAFT
    : PURCHASE_ORDER_STATUS.PENDING;
  const normalizedLinesForCreate = processedLines.map((line) => ({
    ...line,
    lineStatus: "Pending",
  }));

  const purchaseOrder = await PurchaseOrder.create({
    poNumber,
    supplierId,
    supplierName: supplier.name,
    date: orderDate,
    lines: normalizedLinesForCreate,
    subtotal,
    totalAmount: subtotal,
    totalMeters: totalMetersSum,
    poStatus: headerStatus,
    supplierLeadTime: effectiveLeadTime,
    expectedDeliveryDate: computedExpectedDate,
    notes,
    createdBy: req.user?._id,
  });

  const populatedOrder = await PurchaseOrder.findById(purchaseOrder._id)
    .populate("supplierId", "name supplierCode")
    .populate(
      "lines.skuId",
      "skuCode categoryName gsm qualityName widthInches"
    );

  res.status(201).json({
    success: true,
    data: populatedOrder,
  });
});

// Update purchase order
const updatePurchaseOrder = handleAsyncErrors(async (req, res) => {
  const {
    lines,
    notes,
    status: requestedStatusLegacy,
    poStatus: requestedPoStatus,
    saveAsDraft,
    expectedDeliveryDate,
    date,
    supplierLeadTime: supplierLeadTimeInput,
  } = req.body;

  const purchaseOrder = await PurchaseOrder.findById(req.params.id);
  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (date) {
    const normalizedDate = normalizeDateInput(date);
    if (normalizedDate) {
      purchaseOrder.date = normalizedDate;
    }
  }

  if (supplierLeadTimeInput !== undefined) {
    purchaseOrder.supplierLeadTime = sanitizeNumber(supplierLeadTimeInput);
  }

  // Recalculate totals if lines are updated
  if (lines) {
    let subtotal = 0;
    let totalMetersSum = 0;

    const processedLines = (lines || []).map((line = {}) => {
      const qtyRolls = sanitizeNumber(line.qtyRolls);
      const overrideRatePerRoll = normalizeNullableNumber(line.overrideRatePerRoll);
      const baseRate44 = sanitizeNumber(line.baseRate44);
      const derivedRatePerRoll =
        sanitizeNumber(line.derivedRatePerRoll) ||
        deriveWidthRate(baseRate44, line.widthInches);
      const finalRatePerRoll =
        overrideRatePerRoll !== null && overrideRatePerRoll !== undefined
          ? sanitizeNumber(overrideRatePerRoll)
          : derivedRatePerRoll || sanitizeNumber(line.ratePerRoll);
      const ratePerRoll = finalRatePerRoll;
      const lengthMetersPerRoll = sanitizeNumber(line.lengthMetersPerRoll);
      const incomingTotalMeters = sanitizeNumber(line.totalMeters);
      const lineMeters =
        incomingTotalMeters > 0 ? incomingTotalMeters : qtyRolls * lengthMetersPerRoll;
      const lineTotal = lineMeters * ratePerRoll;
      const lineStatus =
        typeof line.lineStatus === "string" && line.lineStatus.trim()
          ? line.lineStatus
          : typeof line.status === "string" && line.status.trim()
          ? line.status
          : "Pending";
      const { taxRate: _ignoredTaxRate, skuId: rawSkuId, ...restLine } = line || {};
      const skuId = rawSkuId || undefined;

      subtotal += lineTotal;
      totalMetersSum += lineMeters;

      return {
        ...restLine,
        ...(skuId ? { skuId } : {}),
        baseRate44,
        derivedRatePerRoll,
        overrideRatePerRoll,
        qtyRolls,
        ratePerRoll,
        lengthMetersPerRoll,
        totalMeters: lineMeters,
        lineTotal,
        lineStatus,
      };
    });

    purchaseOrder.lines = processedLines;
    purchaseOrder.subtotal = subtotal;
    purchaseOrder.totalAmount = subtotal;
    purchaseOrder.totalMeters = totalMetersSum;
  }

  const latestLines = purchaseOrder.lines || [];
  let headerStatus;
  if (saveAsDraft) {
    headerStatus = PURCHASE_ORDER_STATUS.DRAFT;
    purchaseOrder.lines = latestLines.map((line) => ({
      ...line,
      lineStatus: "Pending",
    }));
  } else {
    const requestedStatus = requestedPoStatus || requestedStatusLegacy;
    headerStatus = deriveOrderStatusFromLines(latestLines);

    // If a valid status is explicitly provided, let it override derived only when it's Draft/Pending/Partial/Complete
    if (
      Object.values(PURCHASE_ORDER_STATUS).includes(requestedStatus) &&
      ["Draft", "Pending", "Partial", "Complete"].includes(requestedStatus)
    ) {
      headerStatus = requestedStatus;
    }
  }
  purchaseOrder.poStatus = headerStatus;

  if (expectedDeliveryDate !== undefined) {
    purchaseOrder.expectedDeliveryDate = normalizeDateInput(expectedDeliveryDate);
  } else if (!purchaseOrder.expectedDeliveryDate) {
    const effectiveLeadTime =
      purchaseOrder.supplierLeadTime || sanitizeNumber(purchaseOrder.supplierLeadTime) || 7;
    purchaseOrder.expectedDeliveryDate = computeExpectedDate(
      { date: purchaseOrder.date },
      effectiveLeadTime
    );
  }

  if (notes !== undefined) purchaseOrder.notes = notes;

  await purchaseOrder.save();

  const populatedOrder = await PurchaseOrder.findById(purchaseOrder._id)
    .populate("supplierId", "name supplierCode")
    .populate(
      "lines.skuId",
      "skuCode categoryName gsm qualityName widthInches"
    );

  res.json({
    success: true,
    data: populatedOrder,
  });
});

// Approve purchase order
const approvePurchaseOrder = handleAsyncErrors(async (req, res) => {
  const purchaseOrder = await PurchaseOrder.findById(req.params.id);

  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (purchaseOrder.poStatus !== PURCHASE_ORDER_STATUS.DRAFT) {
    throw new AppError(
      "Only draft purchase orders can be approved",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  purchaseOrder.poStatus = PURCHASE_ORDER_STATUS.APPROVED;
  purchaseOrder.approvedBy = req.user?._id;
  purchaseOrder.approvedAt = new Date();
  await purchaseOrder.save();

  res.json({
    success: true,
    data: purchaseOrder,
  });
});

// Close purchase order
const closePurchaseOrder = handleAsyncErrors(async (req, res) => {
  const purchaseOrder = await PurchaseOrder.findById(req.params.id);
  const reason = req.body?.reason;

  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (purchaseOrder.poStatus === PURCHASE_ORDER_STATUS.CLOSED) {
    return res.json({
      success: true,
      data: purchaseOrder,
      message: "Purchase order already closed",
    });
  }

  if (purchaseOrder.poStatus === PURCHASE_ORDER_STATUS.CANCELLED) {
    throw new AppError(
      "Cancelled purchase orders cannot be closed",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  if (
    ![
      PURCHASE_ORDER_STATUS.APPROVED,
      PURCHASE_ORDER_STATUS.PARTIAL,
      "PartiallyReceived",
      PURCHASE_ORDER_STATUS.COMPLETE,
    ].includes(purchaseOrder.poStatus)
  ) {
    throw new AppError(
      "Only approved or partially received purchase orders can be closed",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  purchaseOrder.poStatus = PURCHASE_ORDER_STATUS.CLOSED;
  purchaseOrder.closeReason =
    reason || purchaseOrder.closeReason || "Closed manually";
  purchaseOrder.closedAt = new Date();
  purchaseOrder.closedBy = req.user?._id || purchaseOrder.closedBy;
  await purchaseOrder.save();

  res.json({
    success: true,
    data: purchaseOrder,
  });
});

// Cancel purchase order
const cancelPurchaseOrder = handleAsyncErrors(async (req, res) => {
  const purchaseOrder = await PurchaseOrder.findById(req.params.id);
  const reason = req.body?.reason;

  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if ([PURCHASE_ORDER_STATUS.CANCELLED, PURCHASE_ORDER_STATUS.CLOSED].includes(purchaseOrder.poStatus)) {
    throw new AppError(
      "Purchase order is already closed or cancelled",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  if (![PURCHASE_ORDER_STATUS.DRAFT, PURCHASE_ORDER_STATUS.APPROVED, PURCHASE_ORDER_STATUS.PENDING, PURCHASE_ORDER_STATUS.PARTIAL].includes(purchaseOrder.poStatus)) {
    throw new AppError(
      "Only draft, pending, approved or partially received purchase orders can be cancelled",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  purchaseOrder.poStatus = PURCHASE_ORDER_STATUS.CANCELLED;
  purchaseOrder.cancelReason =
    reason || purchaseOrder.cancelReason || "Cancelled manually";
  purchaseOrder.cancelledAt = new Date();
  purchaseOrder.cancelledBy = req.user?._id || purchaseOrder.cancelledBy;

  await purchaseOrder.save();

  res.json({
    success: true,
    data: purchaseOrder,
  });
});

// Record an overdue reminder/escalation trigger
const remindPurchaseOrder = handleAsyncErrors(async (req, res) => {
  const purchaseOrder = await PurchaseOrder.findById(req.params.id);
  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  const overdueInfo = buildOverdueInfo(purchaseOrder);

  if (!overdueInfo.isOverdue) {
    throw new AppError(
      "Purchase order is not overdue for reminder",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  purchaseOrder.lastReminderAt = new Date();
  purchaseOrder.reminderCount = (purchaseOrder.reminderCount || 0) + 1;
  await purchaseOrder.save();

  res.json({
    success: true,
    data: purchaseOrder,
    reminder: {
      lastReminderAt: purchaseOrder.lastReminderAt,
      reminderCount: purchaseOrder.reminderCount,
    },
    overdue: overdueInfo,
    message: "Reminder recorded for overdue purchase order",
  });
});

module.exports = {
  getPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  approvePurchaseOrder,
  closePurchaseOrder,
  cancelPurchaseOrder,
  remindPurchaseOrder,
};
