const mongoose = require("mongoose");
const PurchaseReturn = require("../models/PurchaseReturn");
const PurchaseInvoice = require("../models/PurchaseInvoice");
const Roll = require("../models/Roll");
const Voucher = require("../models/Voucher");
const Ledger = require("../models/Ledger");
const numberingService = require("../services/numberingService");
const { STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? 0 : numeric;
};

const ensureSystemLedger = async (code) => {
  const existing = await Ledger.findOne({ ledgerCode: code });
  if (existing) return existing;

  const defaults = {
    INVENTORY: { name: "Inventory", group: "Assets" },
    INPUT_TAX: { name: "Input Tax", group: "Assets" },
    AP: { name: "Accounts Payable", group: "Liabilities" },
  }[code];

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

const applyLedgerDelta = async (ledger, debit = 0, credit = 0) => {
  const increaseOnDebit = ["Assets", "Expenses"].includes(ledger.group);
  const delta = increaseOnDebit ? debit - credit : credit - debit;
  ledger.currentBalance = toNumber(ledger.currentBalance) + delta;
  await ledger.save();
};

const findMatchingPiLine = (pi, roll) => {
  const lines = pi?.lines || [];
  if (!lines.length) return null;

  const rollPoLineId = roll?.poLineId?.toString?.() || roll?.poLineId;
  if (rollPoLineId) {
    const byPo = lines.find((l) => (l?.poLineId?.toString?.() || l?.poLineId) == rollPoLineId);
    if (byPo) return byPo;
  }

  const rollSkuId = roll?.skuId?._id || roll?.skuId;
  const rollSkuStr = rollSkuId ? String(rollSkuId) : "";
  const rollWidth = toNumber(roll?.widthInches);
  const rollGsm = (roll?.gsm || "").toString();
  const rollQuality = (roll?.qualityName || roll?.qualityGrade || "").toString();

  return (
    lines.find((l) => {
      const lineSkuId = l?.skuId?._id || l?.skuId;
      const lineSkuStr = lineSkuId ? String(lineSkuId) : "";
      if (rollSkuStr && lineSkuStr && rollSkuStr !== lineSkuStr) return false;
      if (rollWidth && toNumber(l?.widthInches) && rollWidth !== toNumber(l?.widthInches)) return false;
      if (rollGsm && l?.gsm && String(l.gsm) !== rollGsm) return false;
      if (rollQuality && l?.qualityName && String(l.qualityName) !== rollQuality) return false;
      return true;
    }) || null
  );
};

// List purchase returns
const getPurchaseReturns = handleAsyncErrors(async (req, res) => {
  const { status, supplierId, purchaseInvoiceId, dateFrom, dateTo } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (supplierId) filter.supplierId = supplierId;
  if (purchaseInvoiceId) filter.purchaseInvoiceId = purchaseInvoiceId;
  if (dateFrom || dateTo) {
    filter.prDate = {};
    if (dateFrom) filter.prDate.$gte = new Date(dateFrom);
    if (dateTo) filter.prDate.$lte = new Date(dateTo);
  }

  const rows = await PurchaseReturn.find(filter)
    .populate("supplierId", "name supplierCode")
    .populate("purchaseInvoiceId", "piNumber status")
    .sort({ createdAt: -1 });

  res.json({ success: true, count: rows.length, data: rows });
});

// Get single purchase return
const getPurchaseReturn = handleAsyncErrors(async (req, res) => {
  const row = await PurchaseReturn.findById(req.params.id)
    .populate("supplierId", "name supplierCode address")
    .populate("purchaseInvoiceId", "piNumber status gstMode sgst cgst igst");

  if (!row) throw new AppError("Purchase return not found", 404, "RESOURCE_NOT_FOUND");

  res.json({ success: true, data: row });
});

// Create purchase return (draft) from a posted PI + rollIds.
const createPurchaseReturn = handleAsyncErrors(async (req, res) => {
  const { purchaseInvoiceId, rollIds = [], prDate, reason } = req.body;

  if (!purchaseInvoiceId || !mongoose.Types.ObjectId.isValid(String(purchaseInvoiceId))) {
    throw new AppError("Valid purchaseInvoiceId is required", 400, "VALIDATION_ERROR");
  }
  if (!Array.isArray(rollIds) || rollIds.length === 0) {
    throw new AppError("rollIds array is required", 400, "VALIDATION_ERROR");
  }

  const pi = await PurchaseInvoice.findById(purchaseInvoiceId);
  if (!pi) throw new AppError("Purchase invoice not found", 404, "RESOURCE_NOT_FOUND");
  if (pi.status !== STATUS.POSTED) {
    throw new AppError("Purchase return must reference a posted purchase invoice", 400, "INVALID_STATE_TRANSITION");
  }

  const normalizedRollIds = rollIds
    .map((id) => (id && typeof id === "object" ? id._id : id))
    .map((id) => String(id))
    .filter(Boolean);

  const existing = await PurchaseReturn.findOne({
    purchaseInvoiceId: pi._id,
    status: { $in: [STATUS.DRAFT, STATUS.POSTED] },
    "lines.rollId": { $in: normalizedRollIds },
  }).select("_id prNumber status");

  if (existing) {
    throw new AppError(
      `A purchase return already exists for one or more selected rolls (PR: ${existing.prNumber}, status: ${existing.status})`,
      400,
      "DUPLICATE_RETURN"
    );
  }

  const rolls = await Roll.find({ _id: { $in: normalizedRollIds } });
  if (rolls.length !== normalizedRollIds.length) {
    throw new AppError("One or more rolls were not found", 404, "RESOURCE_NOT_FOUND");
  }

  const wrongInvoice = rolls.filter((r) => String(r.purchaseInvoiceId || "") !== String(pi._id));
  if (wrongInvoice.length) {
    throw new AppError("One or more selected rolls do not belong to the referenced purchase invoice", 400, "VALIDATION_ERROR");
  }

  let subtotal = 0;
  let taxAmount = 0;

  const lines = rolls.map((roll) => {
    const piLine = findMatchingPiLine(pi, roll);
    if (!piLine) {
      throw new AppError(
        `Could not match roll ${roll.rollNumber} to a purchase invoice line for tax reversal`,
        400,
        "VALIDATION_ERROR"
      );
    }

    const lengthMeters = toNumber(roll.currentLengthMeters ?? roll.originalLengthMeters);
    const ratePerMeter = toNumber(piLine.ratePerRoll);
    const taxRate = toNumber(piLine.taxRate ?? 0);
    const base = lengthMeters * ratePerMeter;
    const tax = base * (taxRate / 100);

    subtotal += base;
    taxAmount += tax;

    return {
      rollId: roll._id,
      rollNumber: roll.rollNumber,
      skuId: roll.skuId || piLine.skuId,
      skuCode: roll.skuCode || piLine.skuCode,
      categoryName: roll.categoryName || piLine.categoryName,
      gsm: roll.gsm || piLine.gsm,
      qualityName: roll.qualityName || piLine.qualityName,
      widthInches: toNumber(roll.widthInches || piLine.widthInches),
      lengthMeters,
      ratePerMeter,
      taxRate,
      lineBaseTotal: base,
      lineTax: tax,
      lineTotal: base + tax,
      hsnCode: pi.hsnCode,
      poLineId: roll.poLineId || piLine.poLineId,
    };
  });

  const gstMode = pi.gstMode || "intra";
  const sgst = gstMode === "intra" ? taxAmount / 2 : 0;
  const cgst = gstMode === "intra" ? taxAmount / 2 : 0;
  const igst = gstMode === "inter" ? taxAmount : 0;
  const total = subtotal + taxAmount;

  const prNumber = await numberingService.generateNumber("PR", PurchaseReturn, "prNumber");

  const created = await PurchaseReturn.create({
    prNumber,
    purchaseInvoiceId: pi._id,
    piNumber: pi.piNumber,
    supplierId: pi.supplierId,
    supplierName: pi.supplierName,
    prDate: prDate ? new Date(prDate) : new Date(),
    gstMode,
    sgst,
    cgst,
    igst,
    status: STATUS.DRAFT,
    reason,
    lines,
    subtotal,
    taxAmount,
    total,
    createdBy: req.user?._id || undefined,
  });

  res.status(201).json({ success: true, data: created });
});

const ensurePurchaseReturnVoucher = async (purchaseReturn, userId) => {
  if (!purchaseReturn) return null;

  if (purchaseReturn.voucherId) {
    const existing = await Voucher.findById(purchaseReturn.voucherId);
    if (existing) return existing;
  }

  const [inventoryLedger, inputTaxLedger, apLedger] = await Promise.all([
    ensureSystemLedger("INVENTORY"),
    ensureSystemLedger("INPUT_TAX"),
    ensureSystemLedger("AP"),
  ]);

  const base = toNumber(purchaseReturn.subtotal);
  const tax = toNumber(purchaseReturn.taxAmount);
  const total = toNumber(purchaseReturn.total);

  const voucherNumber = await numberingService.generateNumber(
    "VCH",
    Voucher,
    "voucherNumber"
  );

  const voucher = await Voucher.create({
    voucherNumber,
    voucherType: "DebitNote",
    date: purchaseReturn.prDate || new Date(),
    referenceType: "DebitNote",
    referenceId: purchaseReturn._id,
    referenceNumber: purchaseReturn.prNumber,
    narration: `Purchase return ${purchaseReturn.prNumber} against PI ${purchaseReturn.piNumber || ""}`,
    lines: [
      {
        ledgerId: apLedger._id,
        ledgerName: apLedger.name,
        debit: total,
        credit: 0,
        description: `Supplier debit - ${purchaseReturn.supplierName || ""}`,
      },
      {
        ledgerId: inventoryLedger._id,
        ledgerName: inventoryLedger.name,
        debit: 0,
        credit: base,
        description: "Inventory reversal (return to supplier)",
      },
      {
        ledgerId: inputTaxLedger._id,
        ledgerName: inputTaxLedger.name,
        debit: 0,
        credit: tax,
        description: "Input tax reversal",
      },
    ],
    totalDebit: total,
    totalCredit: base + tax,
    status: STATUS.POSTED,
    postedAt: new Date(),
    postedBy: userId || purchaseReturn.postedBy,
    createdBy: purchaseReturn.createdBy,
  });

  await Promise.all([
    applyLedgerDelta(apLedger, total, 0),
    applyLedgerDelta(inventoryLedger, 0, base),
    applyLedgerDelta(inputTaxLedger, 0, tax),
  ]);

  return voucher;
};

// Post purchase return: set roll statuses + auto voucher
const postPurchaseReturn = handleAsyncErrors(async (req, res) => {
  const updated = await PurchaseReturn.findOneAndUpdate(
    { _id: req.params.id, status: STATUS.DRAFT },
    { status: STATUS.POSTED, postedAt: new Date(), postedBy: req.user?._id || undefined },
    { new: true }
  );

  let purchaseReturn = updated;
  if (!purchaseReturn) {
    purchaseReturn = await PurchaseReturn.findById(req.params.id);
    if (!purchaseReturn) throw new AppError("Purchase return not found", 404, "RESOURCE_NOT_FOUND");
    if (purchaseReturn.status !== STATUS.POSTED) {
      throw new AppError("Only draft purchase returns can be posted", 400, "INVALID_STATE_TRANSITION");
    }
  }

  // Update roll statuses to ReturnedToSupplier
  const rollIds = (purchaseReturn.lines || []).map((l) => l.rollId).filter(Boolean);
  if (rollIds.length) {
    await Roll.updateMany(
      { _id: { $in: rollIds } },
      {
        $set: {
          status: "ReturnedToSupplier",
          "returnDetails.returnReason": purchaseReturn.reason || "Purchase return",
          "returnDetails.returnedAt": new Date(),
        },
      }
    );
  }

  if (purchaseReturn.status === STATUS.POSTED) {
    const voucher = await ensurePurchaseReturnVoucher(purchaseReturn, req.user?._id);
    if (voucher && !purchaseReturn.voucherId) {
      purchaseReturn.voucherId = voucher._id;
      await purchaseReturn.save();
    }
  }

  res.json({ success: true, data: purchaseReturn });
});

// Cancel draft purchase return
const cancelPurchaseReturn = handleAsyncErrors(async (req, res) => {
  const row = await PurchaseReturn.findById(req.params.id);
  if (!row) throw new AppError("Purchase return not found", 404, "RESOURCE_NOT_FOUND");

  if (row.status === STATUS.CANCELLED) {
    return res.json({ success: true, data: row });
  }
  if (row.status !== STATUS.DRAFT) {
    throw new AppError("Only draft purchase returns can be cancelled", 400, "INVALID_STATE_TRANSITION");
  }

  row.status = STATUS.CANCELLED;
  row.cancelReason = req.body?.reason;
  row.cancelledAt = new Date();
  row.cancelledBy = req.user?._id || undefined;
  await row.save();

  res.json({ success: true, data: row });
});

module.exports = {
  getPurchaseReturns,
  getPurchaseReturn,
  createPurchaseReturn,
  postPurchaseReturn,
  cancelPurchaseReturn,
};

