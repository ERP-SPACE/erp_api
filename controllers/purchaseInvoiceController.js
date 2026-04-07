const PurchaseInvoice = require("../models/PurchaseInvoice");
const PurchaseOrder = require("../models/PurchaseOrder");
const Batch = require("../models/Batch");
const Roll = require("../models/Roll");
const Supplier = require("../models/Supplier");
const Ledger = require("../models/Ledger");
const Voucher = require("../models/Voucher");
const numberingService = require("../services/numberingService");
const { STATUS, PURCHASE_ORDER_STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? 0 : numeric;
};

// Normalise rollDetails to the canonical individual-roll format: [{ lengthMeters }].
// Accepts BOTH the old grouped format { rollQty, metersPerRoll } (expands to N entries)
// and the new per-roll format { lengthMeters } (passes through).  This ensures
// backward-compatibility with any data stored before the schema change.
const normalizeRollDetails = (rollDetails = []) => {
  if (!Array.isArray(rollDetails)) return [];
  const expanded = [];
  for (const detail of rollDetails) {
    if (!detail) continue;
    if (detail.lengthMeters !== undefined) {
      // New per-roll format — pass through
      const len = toNumber(detail.lengthMeters);
      if (len > 0) expanded.push({ lengthMeters: len });
    } else if (
      detail.rollQty !== undefined ||
      detail.metersPerRoll !== undefined
    ) {
      // Old grouped format — expand each group to individual roll entries
      const qty = Math.max(Math.round(toNumber(detail.rollQty)), 0);
      const mpr = toNumber(detail.metersPerRoll);
      if (qty > 0 && mpr > 0) {
        for (let i = 0; i < qty; i++) expanded.push({ lengthMeters: mpr });
      }
    }
  }
  return expanded;
};

// Aggregate stats derived from an individual-roll array.
const summarizeRollDetails = (rollDetails = []) => {
  const normalized = normalizeRollDetails(rollDetails);
  const totalRolls = normalized.length;
  const totalMeters = normalized.reduce((s, r) => s + r.lengthMeters, 0);
  const avgMetersPerRoll = totalRolls > 0 ? totalMeters / totalRolls : 0;
  return { normalized, totalRolls, totalMeters, avgMetersPerRoll };
};

const deriveRollMetrics = (line = {}) => {
  const summary = summarizeRollDetails(line.rollDetails);
  const rollCount =
    summary.totalRolls ||
    toNumber(line.inwardRolls) ||
    toNumber(line.qtyRolls) ||
    toNumber(line.receivedQty) ||
    0;

  const lengthPerRoll =
    summary.avgMetersPerRoll ||
    toNumber(line.lengthMetersPerRoll) ||
    (rollCount > 0 && toNumber(line.totalMeters || line.inwardMeters)
      ? toNumber(line.totalMeters || line.inwardMeters) / rollCount
      : 0);

  // totalMeters is always driven by individual roll lengths when available
  const totalMeters =
    summary.totalMeters ||
    toNumber(line.inwardMeters) ||
    (lengthPerRoll && rollCount ? lengthPerRoll * rollCount : 0);

  return {
    rollCount,
    lengthPerRoll,
    totalMeters,
    rollDetails: summary.normalized,
    summary,
  };
};

const buildPoLineKey = (line = {}) => {
  const keyParts = [
    line.skuId?.toString?.() || line.skuId || "",
    line.widthInches || line.width || "",
    line.gsm || "",
    line.qualityName || "",
  ];
  return keyParts.join("|");
};

const resolvePoLineIdForInvoice = (line = {}, poLineById = new Map(), poLineByKey = new Map()) => {
  let id = line.poLineId?.toString?.() || line.poLineId;
  if (!id) {
    const lookupKey = buildPoLineKey(line);
    id = poLineByKey.get(lookupKey);
  }
  return id;
};

// Get all purchase invoices
const getPurchaseInvoices = handleAsyncErrors(async (req, res) => {
  const { status, supplierId, purchaseOrderId, dateFrom, dateTo } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (supplierId) filter.supplierId = supplierId;
  if (purchaseOrderId) filter.purchaseOrderId = purchaseOrderId;
  if (dateFrom || dateTo) {
    filter.date = {};
    if (dateFrom) filter.date.$gte = new Date(dateFrom);
    if (dateTo) filter.date.$lte = new Date(dateTo);
  }

  const purchaseInvoices = await PurchaseInvoice.find(filter)
    .populate("supplierId", "name supplierCode")
    .populate("purchaseOrderId", "poNumber")
    .sort({ createdAt: -1 });

  res.json({
    success: true,
    count: purchaseInvoices.length,
    data: purchaseInvoices,
  });
});

// Get single purchase invoice
const getPurchaseInvoice = handleAsyncErrors(async (req, res) => {
  const purchaseInvoice = await PurchaseInvoice.findById(req.params.id)
    .populate("supplierId", "name supplierCode address")
    .populate("purchaseOrderId", "poNumber supplierName date");

  if (!purchaseInvoice) {
    throw new AppError("Purchase invoice not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({
    success: true,
    data: purchaseInvoice,
  });
});

// Create purchase invoice
const createPurchaseInvoice = handleAsyncErrors(async (req, res) => {
  const {
    supplierInvoiceNumber,
    supplierChallanNumber,
    purchaseOrderId,
    lines = [],
    landedCosts = [],
    notes,
    lrNumber,
    lrDate,
    caseNumber,
    hsnCode,
    gstMode = "intra",
    sgst,
    cgst,
    igst,
    date,
  } = req.body;

  if (!purchaseOrderId) {
    throw new AppError("Purchase order is required", 400, "VALIDATION_ERROR");
  }

  // Verify purchase order exists
  const purchaseOrder = await PurchaseOrder.findById(purchaseOrderId);
  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (
    purchaseOrder.poStatus === PURCHASE_ORDER_STATUS.CLOSED ||
    purchaseOrder.poStatus === PURCHASE_ORDER_STATUS.CANCELLED
  ) {
    throw new AppError(
      "Cannot create invoice for a closed or cancelled purchase order",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  const poLineById = new Map();
  const poLineByKey = new Map();
  (purchaseOrder.lines || []).forEach((line = {}) => {
    const id = line._id?.toString?.();
    if (id) {
      poLineById.set(id, line);
      const key = buildPoLineKey(line);
      if (key && !poLineByKey.has(key)) {
        poLineByKey.set(key, id);
      }
    }
  });

  if (!lines || !lines.length) {
    throw new AppError(
      "At least one invoice line is required",
      400,
      "VALIDATION_ERROR"
    );
  }

  // Generate PI number
  const piNumber = await numberingService.generateNumber("PI", PurchaseInvoice);

  // Process lines
  let subtotal = 0;
  let computedLineTax = 0;

  const processedLines = (lines || []).map((line) => {
    const poLineId = resolvePoLineIdForInvoice(line, poLineById, poLineByKey);
    if (!poLineId || !poLineById.has(poLineId)) {
      throw new AppError(
        "Each invoice line must reference a valid purchase order line",
        400,
        "VALIDATION_ERROR"
      );
    }

    const poLine = poLineById.get(poLineId);
    const orderedRolls = toNumber(poLine.qtyRolls);
    const alreadyInvoiced = toNumber(poLine.invoicedQty);
    const remainingOrdered = Math.max(orderedRolls - alreadyInvoiced, 0);

    const rollInfo = deriveRollMetrics(line);

    // Use roll count (never meters) for validation; do not mutate user-entered qty
    const requestedQty = toNumber(line.qtyRolls) || rollInfo.rollCount;
    const qty = requestedQty;
    if (qty <= 0) {
      throw new AppError(
        "Invoice quantity must be greater than zero",
        400,
        "VALIDATION_ERROR"
      );
    }

    if (remainingOrdered <= 0) {
      throw new AppError(
        "All ordered quantity is already invoiced for one or more lines",
        400,
        "VALIDATION_ERROR"
      );
    }

    if (qty > remainingOrdered) {
      throw new AppError(
        `Invoice quantity ${qty} exceeds remaining ordered quantity ${remainingOrdered} for the purchase order line`,
        400,
        "VALIDATION_ERROR"
      );
    }

    // Only enforce rollCount limit when qtyRolls was NOT explicitly provided.
    // When qtyRolls is explicitly set it is the authoritative invoiced quantity
    // (already validated above). rollDetails are supplementary physical records
    // and their sum may legitimately differ from the invoiced quantity
    // (e.g. supplier delivers 55 rolls but only 50 were ordered/invoiced).
    if (!toNumber(line.qtyRolls) && rollInfo.rollCount > remainingOrdered) {
      throw new AppError(
        `Roll quantity ${rollInfo.rollCount} exceeds remaining ordered quantity ${remainingOrdered} for the purchase order line`,
        400,
        "VALIDATION_ERROR"
      );
    }

    const rate = toNumber(line.ratePerRoll) || toNumber(poLine.ratePerRoll);
    const taxRate = toNumber(line.taxRate ?? poLine.taxRate ?? 0);
    const lengthMetersPerRoll =
      rollInfo.lengthPerRoll ||
      toNumber(poLine.lengthMetersPerRoll);

    // Auto-generate per-roll entries when the caller only provides qty + meterPerRoll.
    // rollDetails is the source of truth; generate only when nothing was provided.
    let resolvedRollDetails = rollInfo.rollDetails;
    if (!resolvedRollDetails.length && qty > 0 && lengthMetersPerRoll > 0) {
      resolvedRollDetails = Array.from({ length: qty }, () => ({
        lengthMeters: lengthMetersPerRoll,
      }));
    }

    // totalMeters = SUM(rollDetails.lengthMeters) — not qty × meterPerRoll
    const totalMeters =
      resolvedRollDetails.length > 0
        ? resolvedRollDetails.reduce((s, r) => s + r.lengthMeters, 0)
        : toNumber(line.totalMeters) || qty * (lengthMetersPerRoll || 0);

    const inwardRolls = resolvedRollDetails.length || rollInfo.rollCount || qty;
    const inwardMeters = totalMeters;

    const lineBaseTotal = totalMeters * rate; // price per meter × total meters
    const lineTax = lineBaseTotal * (taxRate / 100);

    subtotal += lineBaseTotal;
    computedLineTax += lineTax;

    return {
      ...line,
      poLineId,
      poId: purchaseOrderId,
      poNumber: purchaseOrder.poNumber,
      skuId: line.skuId || poLine.skuId,
      skuCode: line.skuCode || poLine.skuCode,
      categoryName: line.categoryName || poLine.categoryName,
      qualityName: line.qualityName || poLine.qualityName,
      gsm: line.gsm || poLine.gsm,
      widthInches: line.widthInches || poLine.widthInches,
      lengthMetersPerRoll,
      qtyRolls: qty,
      ratePerRoll: rate,
      taxRate,
      totalMeters,
      inwardRolls,
      inwardMeters,
      rollDetails: resolvedRollDetails,
      lineTotal: lineBaseTotal, // tax-exclusive; GST handled at invoice level
    };
  });

  // Tax amounts
  const normalizedSGST = sgst !== undefined ? Number(sgst) || 0 : null;
  const normalizedCGST = cgst !== undefined ? Number(cgst) || 0 : null;
  const normalizedIGST = igst !== undefined ? Number(igst) || 0 : null;

  let sgstAmount = normalizedSGST;
  let cgstAmount = normalizedCGST;
  let igstAmount = normalizedIGST;

  if (
    sgstAmount === null ||
    cgstAmount === null ||
    igstAmount === null
  ) {
    const isInter = gstMode === "inter";
    sgstAmount = isInter ? 0 : subtotal * 0.09;
    cgstAmount = isInter ? 0 : subtotal * 0.09;
    igstAmount = isInter ? subtotal * 0.18 : 0;
  }

  const taxAmount = (sgstAmount || 0) + (cgstAmount || 0) + (igstAmount || 0);

  // Calculate landed costs
  const totalLandedCost = (landedCosts || []).reduce(
    (sum, cost) => sum + (Number(cost.amount) || 0),
    0
  );

  const purchaseInvoice = await PurchaseInvoice.create({
    piNumber,
    supplierInvoiceNumber,
    supplierChallanNumber,
    purchaseOrderId,
    supplierId: purchaseOrder.supplierId,
    supplierName: purchaseOrder.supplierName,
    date: date ? new Date(date) : new Date(),
    lrNumber,
    lrDate: lrDate ? new Date(lrDate) : undefined,
    caseNumber,
    hsnCode,
    gstMode,
    sgst: sgstAmount,
    cgst: cgstAmount,
    igst: igstAmount,
    lines: processedLines,
    subtotal,
    taxAmount,
    total: subtotal + taxAmount,
    landedCosts,
    totalLandedCost,
    grandTotal: subtotal + taxAmount + totalLandedCost,
    createdBy: req.user?._id || undefined,
    notes,
  });

  const populatedInvoice = await PurchaseInvoice.findById(purchaseInvoice._id)
    .populate("supplierId", "name supplierCode")
    .populate("purchaseOrderId", "poNumber");

  res.status(201).json({
    success: true,
    data: populatedInvoice,
  });
});

// Allocate landed costs
const allocateLandedCost = handleAsyncErrors(async (req, res) => {
  const { landedCostId } = req.body;

  const purchaseInvoice = await PurchaseInvoice.findById(req.params.id);
  if (!purchaseInvoice) {
    throw new AppError("Purchase invoice not found", 404, "RESOURCE_NOT_FOUND");
  }

  const landedCost = purchaseInvoice.landedCosts.id(landedCostId);
  if (!landedCost) {
    throw new AppError("Landed cost not found", 404, "RESOURCE_NOT_FOUND");
  }

  // TODO: Implement landed cost allocation logic
  // This would involve finding all rolls related to this PI and allocating costs

  res.json({
    success: true,
    message: "Landed cost allocation completed",
    data: purchaseInvoice,
  });
});

// Post purchase invoice
const postPurchaseInvoice = handleAsyncErrors(async (req, res) => {
  // Atomic status transition to avoid duplicate posting/roll creation
  const updated = await PurchaseInvoice.findOneAndUpdate(
    { _id: req.params.id, status: STATUS.DRAFT },
    {
      status: STATUS.POSTED,
      postedBy: req.user?._id || undefined,
      postedAt: new Date(),
    },
    { new: true }
  );

  let purchaseInvoice = updated;
  const newlyPosted = !!updated;

  if (!purchaseInvoice) {
    purchaseInvoice = await PurchaseInvoice.findById(req.params.id);
    if (!purchaseInvoice) {
      throw new AppError(
        "Purchase invoice not found",
        404,
        "RESOURCE_NOT_FOUND"
      );
    }

    if (purchaseInvoice.status !== STATUS.POSTED) {
      throw new AppError(
        "Only draft purchase invoices can be posted",
        400,
        "INVALID_STATE_TRANSITION"
      );
    }
  }

  if (newlyPosted) {
    await createRollsForPurchaseInvoice(purchaseInvoice);
    await updatePurchaseOrderBalances(purchaseInvoice);
  }

  // Always ensure the accounting voucher exists for a posted invoice
  if (purchaseInvoice.status === STATUS.POSTED) {
    const voucher = await ensurePurchaseInvoiceVoucher(
      purchaseInvoice,
      req.user?._id
    );
    if (voucher && !purchaseInvoice.voucherId) {
      purchaseInvoice.voucherId = voucher._id;
      await purchaseInvoice.save();
    }
  }

  res.json({
    success: true,
    data: purchaseInvoice,
    message: newlyPosted ? undefined : "Purchase invoice already posted",
  });
});

// Create Roll documents when a PI is posted.
// Each entry in line.rollDetails maps 1-to-1 to one physical roll in inventory.
// If rollDetails is empty, rolls are auto-generated from qtyRolls × lengthMetersPerRoll.
const createRollsForPurchaseInvoice = async (purchaseInvoice) => {
  // Idempotency guard — skip if rolls already exist for this PI
  const existingRollCount = await Roll.countDocuments({
    purchaseInvoiceId: purchaseInvoice._id,
  });
  if (existingRollCount > 0) return;

  const supplier = await Supplier.findById(purchaseInvoice.supplierId);
  if (!supplier) {
    throw new AppError("Supplier not found for purchase invoice", 404);
  }

  // Reuse existing batch or create a new one linked to this PI
  const existingBatch = await Batch.findOne({
    purchaseInvoiceId: purchaseInvoice._id,
  });

  const batch =
    existingBatch ||
    (await Batch.create({
      supplierId: supplier._id,
      purchaseInvoiceId: purchaseInvoice._id,
      batchCode: numberingService.generateBatchCode(),
    }));

  // Overhead cost per meter — spread landed costs evenly across all inward meters
  const totalMetersAcrossLines = (purchaseInvoice.lines || []).reduce(
    (sum, line) => sum + (Number(deriveRollMetrics(line).totalMeters) || 0),
    0
  );
  const overheadPerMeter =
    totalMetersAcrossLines > 0
      ? (purchaseInvoice.totalLandedCost || 0) / totalMetersAcrossLines
      : 0;

  const preparedRolls = [];

  for (const line of purchaseInvoice.lines || []) {
    const { rollCount, lengthPerRoll, rollDetails } = deriveRollMetrics(line);
    const width = Number(line.widthInches || line.width || 0);

    if (!rollCount || ![24, 36, 44, 63].includes(width)) continue;

    const rate = Number(line.ratePerRoll) || 0;

    // Build the per-roll length list.
    // rollDetails is [{ lengthMeters }] after normalisation; fall back to uniform
    // lengths when rollDetails is still empty (e.g. very old records or manual lines).
    const rollLengths =
      rollDetails.length > 0
        ? rollDetails.map((d) => toNumber(d.lengthMeters))
        : Array.from({ length: rollCount }, () => lengthPerRoll || 0);

    for (const rollLength of rollLengths) {
      const normalizedLength = Number(rollLength) || 0;
      if (!normalizedLength) continue;

      const seq = preparedRolls.length + 1;
      const rollNumber = `${purchaseInvoice.piNumber}-R${String(seq).padStart(4, "0")}`;

      const baseCostPerMeter = normalizedLength > 0 ? rate / normalizedLength : 0;
      const landedCostPerMeter = baseCostPerMeter + overheadPerMeter;

      preparedRolls.push({
        rollNumber,
        supplierId: supplier._id,
        batchId: batch._id,
        purchaseInvoiceId: purchaseInvoice._id,
        skuId: line.skuId || null,
        skuCode: line.skuCode,
        categoryName: line.categoryName,
        qualityName: line.qualityName,
        gsm: line.gsm,
        widthInches: width,
        originalLengthMeters: normalizedLength,
        currentLengthMeters: normalizedLength,
        status: line.skuId ? "Mapped" : "Unmapped",
        baseCostPerMeter,
        landedCostPerMeter,
        totalLandedCost: Math.round(landedCostPerMeter * normalizedLength * 100) / 100,
        poLineId: line.poLineId,
      });
    }
  }

  if (!preparedRolls.length) return;

  await Roll.insertMany(preparedRolls);

  // Keep batch roll count in sync
  const finalRollCount = await Roll.countDocuments({ batchId: batch._id });
  batch.totalRolls = finalRollCount;
  await batch.save();
};

// Update PO line invoiced quantities and status after posting PI
const updatePurchaseOrderBalances = async (purchaseInvoice) => {
  if (!purchaseInvoice.purchaseOrderId) return;

  const po = await PurchaseOrder.findById(purchaseInvoice.purchaseOrderId);
  if (!po) return;

  let linesUpdated = false;
  const lines = po.lines || [];
  const piLines = purchaseInvoice.lines || [];

  // Map line updates by PO line id (rolls and meters)
  const updatesByLineId = new Map();
  const metersByLineId = new Map();

  // Build a lightweight matcher for PO lines in case poLineId is missing on PI lines
  const poLineByKey = new Map();
  lines.forEach((line) => {
    const keyParts = [
      line.skuId?.toString?.() || line.skuId || "",
      line.widthInches || "",
      line.gsm || "",
      line.qualityName || "",
    ];
    const key = keyParts.join("|");
    if (!poLineByKey.has(key)) {
      poLineByKey.set(key, line._id?.toString?.());
    }
  });

  piLines.forEach((line) => {
    let id = line.poLineId?.toString?.() || line.poLineId;
    if (!id) {
      const keyParts = [
        line.skuId?.toString?.() || line.skuId || "",
        line.widthInches || line.width || "",
        line.gsm || "",
        line.qualityName || "",
      ];
      const key = keyParts.join("|");
      id = poLineByKey.get(key);
    }
    if (!id) return;

    const { rollCount, lengthPerRoll, totalMeters } = deriveRollMetrics(line);
    const resolvedRollCount = rollCount || 0;
    const resolvedMeters =
      totalMeters ||
      (resolvedRollCount > 0 ? lengthPerRoll * resolvedRollCount : 0);

    const existing = updatesByLineId.get(id) || 0;
    updatesByLineId.set(id, existing + resolvedRollCount);

    const existingMeters = metersByLineId.get(id) || 0;
    metersByLineId.set(id, existingMeters + resolvedMeters);
  });

  const updatedLines = lines.map((line) => {
    const id = line._id?.toString?.();
    if (!id) return line;
    const addRolls = updatesByLineId.get(id) || 0;
    const addMeters = metersByLineId.get(id) || 0;
    if (!addRolls && !addMeters) return line;

    const orderedRolls = Number(line.qtyRolls) || 0;
    const orderedMeters =
      Number(line.totalMeters) ||
      orderedRolls * (Number(line.lengthMetersPerRoll) || 0) ||
      0;

    const nextInvoiced = Math.min(
      (Number(line.invoicedQty) || 0) + addRolls,
      orderedRolls
    );
    const nextReceived = Math.min(
      (Number(line.receivedQty) || 0) + addRolls,
      orderedRolls
    );
    const nextReceivedMeters = Math.min(
      (Number(line.receivedMeters) || 0) + addMeters,
      orderedMeters
    );
    linesUpdated = true;
    const isComplete = nextReceived >= (Number(line.qtyRolls) || 0);
    return {
      ...(line.toObject?.() ? line.toObject() : line),
      invoicedQty: nextInvoiced,
      receivedQty: nextReceived,
      receivedMeters: nextReceivedMeters,
      lineStatus: isComplete ? "Complete" : "Pending",
    };
  });

  if (!linesUpdated) return;

  po.lines = updatedLines;

  // Aggregate received roll and meter totals
  const totals = updatedLines.reduce(
    (acc, l) => {
      acc.rolls += Number(l.receivedQty) || 0;
      acc.meters += Number(l.receivedMeters) || 0;
      return acc;
    },
    { rolls: 0, meters: 0 }
  );
  po.totalReceivedRolls = totals.rolls;
  po.totalReceivedMeters = totals.meters;

  const totalLines = updatedLines.length;
  const completeCount = updatedLines.filter(
    (l) => (l.lineStatus || "").toLowerCase() === "complete"
  ).length;

  if (po.poStatus !== PURCHASE_ORDER_STATUS.CANCELLED) {
    const allReceived = updatedLines.every(
      (l) => (Number(l.receivedQty) || 0) >= (Number(l.qtyRolls) || 0)
    );
    const allInvoiced = updatedLines.every(
      (l) => (Number(l.invoicedQty) || 0) >= (Number(l.qtyRolls) || 0)
    );

    if (allReceived && allInvoiced && totalLines > 0) {
      po.poStatus = PURCHASE_ORDER_STATUS.CLOSED;
      po.closedAt = po.closedAt || new Date();
      po.closedBy = purchaseInvoice?.postedBy || po.closedBy;
      po.closeReason =
        po.closeReason ||
        (purchaseInvoice?.piNumber
          ? `Auto-closed on posting PI ${purchaseInvoice.piNumber}`
          : "Auto-closed after full receipt and invoicing");
    } else if (totalLines > 0 && completeCount === totalLines) {
      po.poStatus = PURCHASE_ORDER_STATUS.COMPLETE;
    } else if (completeCount > 0) {
      po.poStatus = PURCHASE_ORDER_STATUS.PARTIAL;
    } else {
      po.poStatus = PURCHASE_ORDER_STATUS.PENDING;
    }
  }

  await po.save();
};

const getLedgerByCode = async (ledgerCode) => {
  const ledger = await Ledger.findOne({ ledgerCode });
  if (!ledger) {
    throw new AppError(
      `Ledger not configured: ${ledgerCode}`,
      500,
      "CONFIG_ERROR"
    );
  }
  return ledger;
};

const applyLedgerDelta = async (ledger, debit = 0, credit = 0) => {
  const increaseOnDebit = ["Assets", "Expenses"].includes(ledger.group);
  const delta = increaseOnDebit ? debit - credit : credit - debit;
  ledger.currentBalance = toNumber(ledger.currentBalance) + delta;
  await ledger.save();
};

const ensurePurchaseInvoiceVoucher = async (purchaseInvoice, userId) => {
  if (!purchaseInvoice) return null;

  if (purchaseInvoice.voucherId) {
    const existing = await Voucher.findById(purchaseInvoice.voucherId);
    if (existing) return existing;
  }

  // Ensure required ledgers exist (auto-create system ledgers if missing)
  const systemLedgerDefaults = {
    INVENTORY: { name: "Inventory", group: "Assets" },
    INPUT_TAX: { name: "Input Tax", group: "Assets" },
    AP: { name: "Accounts Payable", group: "Liabilities" },
  };

  const ensureSystemLedger = async (code) => {
    const existing = await Ledger.findOne({ ledgerCode: code });
    if (existing) return existing;
    const defaults = systemLedgerDefaults[code];
    if (!defaults) {
      throw new AppError(`Ledger not configured: ${code}`, 500, "CONFIG_ERROR");
    }
    return Ledger.create({
      ledgerCode: code,
      name: defaults.name,
      group: defaults.group,
      isSystemLedger: true,
      active: true,
    });
  };

  const [inventoryLedger, inputTaxLedger, apLedger] = await Promise.all([
    ensureSystemLedger("INVENTORY"),
    ensureSystemLedger("INPUT_TAX"),
    ensureSystemLedger("AP"),
  ]);

  const inventoryDebit =
    toNumber(purchaseInvoice.subtotal) +
    toNumber(purchaseInvoice.totalLandedCost);
  const taxAmount = toNumber(purchaseInvoice.taxAmount);
  const totalDebit = inventoryDebit + taxAmount;
  const payableCredit =
    purchaseInvoice.grandTotal !== undefined
      ? toNumber(purchaseInvoice.grandTotal)
      : totalDebit;

  const voucherNumber = await numberingService.generateNumber(
    "VCH",
    Voucher,
    "voucherNumber"
  );

  const voucher = await Voucher.create({
    voucherNumber,
    voucherType: "Purchase",
    date: purchaseInvoice.date || new Date(),
    referenceType: "PurchaseInvoice",
    referenceId: purchaseInvoice._id,
    referenceNumber: purchaseInvoice.piNumber,
    narration: `Purchase invoice ${purchaseInvoice.piNumber}`,
    lines: [
      {
        ledgerId: inventoryLedger._id,
        ledgerName: inventoryLedger.name,
        debit: inventoryDebit,
        credit: 0,
        description: "Inventory capitalization",
      },
      {
        ledgerId: inputTaxLedger._id,
        ledgerName: inputTaxLedger.name,
        debit: taxAmount,
        credit: 0,
        description: "Input tax credit",
      },
      {
        ledgerId: apLedger._id,
        ledgerName: apLedger.name,
        debit: 0,
        credit: payableCredit,
        description: `Accounts payable - ${purchaseInvoice.supplierName || ""}`,
      },
    ],
    totalDebit,
    totalCredit: payableCredit,
    status: STATUS.POSTED,
    postedAt: new Date(),
    postedBy: userId || purchaseInvoice.postedBy,
    createdBy: purchaseInvoice.createdBy,
  });

  await Promise.all([
    applyLedgerDelta(inventoryLedger, inventoryDebit, 0),
    applyLedgerDelta(inputTaxLedger, taxAmount, 0),
    applyLedgerDelta(apLedger, 0, payableCredit),
  ]);

  return voucher;
};

module.exports = {
  getPurchaseInvoices,
  getPurchaseInvoice,
  createPurchaseInvoice,
  allocateLandedCost,
  postPurchaseInvoice,
};
