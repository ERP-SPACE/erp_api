const mongoose = require("mongoose");
const SalesReturn = require("../models/SalesReturn");
const SalesInvoice = require("../models/SalesInvoice");
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

/** Match salesInvoiceController: tax-exclusive rate/roll from tax-inclusive lineTotal when rate missing. */
function resolveRatePerRollFromLine(line) {
  const qty = toNumber(line.qtyRolls) || 1;
  let rate = toNumber(line.ratePerRoll);
  if (rate > 0) return { qty, rate };
  const lt = toNumber(line.lineTotal);
  if (lt > 0) {
    const taxRate = toNumber(line.taxRate);
    const discountPct = toNumber(line.discountLine);
    const taxableFromTotal = taxRate > 0 ? lt / (1 + taxRate / 100) : lt;
    const factor = qty * (1 - discountPct / 100);
    rate = factor > 0 ? taxableFromTotal / factor : 0;
  }
  return { qty, rate };
}

const ensureSystemLedger = async (code) => {
  const existing = await Ledger.findOne({ ledgerCode: code });
  if (existing) return existing;

  const defaults = {
    AR: { name: "Accounts Receivable", group: "Assets" },
    OUTPUT_TAX: { name: "Output Tax", group: "Liabilities" },
    SALES: { name: "Sales", group: "Income" },
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

// List sales returns
const getSalesReturns = handleAsyncErrors(async (req, res) => {
  const { status, customerId, salesInvoiceId, dateFrom, dateTo } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (customerId) filter.customerId = customerId;
  if (salesInvoiceId) filter.salesInvoiceId = salesInvoiceId;
  if (dateFrom || dateTo) {
    filter.srDate = {};
    if (dateFrom) filter.srDate.$gte = new Date(dateFrom);
    if (dateTo) filter.srDate.$lte = new Date(dateTo);
  }

  const rows = await SalesReturn.find(filter)
    .populate("customerId", "companyName customerCode name")
    .populate("salesInvoiceId", "siNumber status")
    .sort({ createdAt: -1 });

  res.json({ success: true, count: rows.length, data: rows });
});

// Get single sales return
const getSalesReturn = handleAsyncErrors(async (req, res) => {
  const row = await SalesReturn.findById(req.params.id)
    .populate("customerId", "companyName customerCode name")
    .populate("salesInvoiceId", "siNumber status");

  if (!row) {
    throw new AppError("Sales return not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({ success: true, data: row });
});

// Create sales return (draft). Tax/rate is copied from originating posted SI.
const createSalesReturn = handleAsyncErrors(async (req, res) => {
  const { salesInvoiceId, rollIds = [], srDate, reason } = req.body;

  if (!salesInvoiceId || !mongoose.Types.ObjectId.isValid(String(salesInvoiceId))) {
    throw new AppError("Valid salesInvoiceId is required", 400, "VALIDATION_ERROR");
  }
  if (!Array.isArray(rollIds) || rollIds.length === 0) {
    throw new AppError("rollIds array is required", 400, "VALIDATION_ERROR");
  }

  const invoice = await SalesInvoice.findById(salesInvoiceId);
  if (!invoice) {
    throw new AppError("Sales invoice not found", 404, "RESOURCE_NOT_FOUND");
  }
  if (invoice.status !== STATUS.POSTED) {
    throw new AppError("Sales return must reference a posted sales invoice", 400, "INVALID_STATE_TRANSITION");
  }

  const normalizedRollIds = rollIds
    .map((id) => (id && typeof id === "object" ? id._id : id))
    .map((id) => String(id))
    .filter(Boolean);

  const siRollIdSet = new Set(
    (invoice.lines || [])
      .map((l) => l?.rollId?.toString?.() || String(l?.rollId || ""))
      .filter(Boolean)
  );

  const invalidRolls = normalizedRollIds.filter((id) => !siRollIdSet.has(id));
  if (invalidRolls.length) {
    throw new AppError("One or more rolls are not part of the referenced sales invoice", 400, "VALIDATION_ERROR");
  }

  const existing = await SalesReturn.findOne({
    salesInvoiceId: invoice._id,
    status: { $in: [STATUS.DRAFT, STATUS.POSTED] },
    "lines.rollId": { $in: normalizedRollIds },
  }).select("_id srNumber status");

  if (existing) {
    throw new AppError(
      `A sales return already exists for one or more selected rolls (SR: ${existing.srNumber}, status: ${existing.status})`,
      400,
      "DUPLICATE_RETURN"
    );
  }

  let subtotal = 0;
  let taxAmount = 0;
  let discountTotal = 0;
  let taxableBase = 0;

  const processedLines = normalizedRollIds.map((rollId) => {
    const siLine = (invoice.lines || []).find(
      (l) => (l?.rollId?.toString?.() || String(l?.rollId || "")) === String(rollId)
    );

    const discountPct = toNumber(siLine?.discountLine);
    const taxRate = toNumber(siLine?.taxRate);

    const { qty, rate } = resolveRatePerRollFromLine({
      ...siLine,
      qtyRolls: 1,
    });

    const lineSubtotal = qty * rate;
    const lineDiscount = lineSubtotal * (discountPct / 100);
    const lineTaxable = lineSubtotal - lineDiscount;
    const lineTax = lineTaxable * (taxRate / 100);

    subtotal += lineSubtotal;
    discountTotal += lineDiscount;
    taxableBase += lineTaxable;
    taxAmount += lineTax;

    return {
      rollId: siLine.rollId,
      rollNumber: siLine.rollNumber,
      siLineRollId: siLine.rollId,
      skuId: siLine.skuId,
      categoryName: siLine.categoryName,
      gsm: siLine.gsm,
      qualityName: siLine.qualityName,
      widthInches: siLine.widthInches,
      billedLengthMeters: siLine.billedLengthMeters,
      qtyRolls: 1,
      ratePerRoll: rate,
      discountLine: discountPct,
      taxRate,
      lineTotal: lineTaxable + lineTax,
      cogsAmount: toNumber(siLine.cogsAmount),
    };
  });

  const total = subtotal - discountTotal + taxAmount;
  const srNumber = await numberingService.generateNumber("SR", SalesReturn, "srNumber");

  const created = await SalesReturn.create({
    srNumber,
    salesInvoiceId: invoice._id,
    siNumber: invoice.siNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    srDate: srDate ? new Date(srDate) : new Date(),
    reason,
    status: STATUS.DRAFT,
    lines: processedLines,
    subtotal,
    discountTotal,
    taxAmount,
    total,
    createdBy: req.user?._id || undefined,
    // computed-only but useful for voucher posting; stored nowhere else
    _computedTaxableBase: taxableBase,
  });

  // Strip computed helper before returning
  const responseObj = created.toObject();
  delete responseObj._computedTaxableBase;

  res.status(201).json({ success: true, data: responseObj });
});

const ensureSalesReturnVoucher = async (salesReturn, taxableBase, userId) => {
  if (!salesReturn) return null;

  if (salesReturn.voucherId) {
    const existing = await Voucher.findById(salesReturn.voucherId);
    if (existing) return existing;
  }

  const [arLedger, outputTaxLedger, salesLedger] = await Promise.all([
    ensureSystemLedger("AR"),
    ensureSystemLedger("OUTPUT_TAX"),
    ensureSystemLedger("SALES"),
  ]);

  const base = toNumber(taxableBase);
  const tax = toNumber(salesReturn.taxAmount);
  const total = toNumber(salesReturn.total);

  const voucherNumber = await numberingService.generateNumber(
    "VCH",
    Voucher,
    "voucherNumber"
  );

  const voucher = await Voucher.create({
    voucherNumber,
    voucherType: "CreditNote",
    date: salesReturn.srDate || new Date(),
    referenceType: "CreditNote",
    referenceId: salesReturn._id,
    referenceNumber: salesReturn.srNumber,
    narration: `Sales return ${salesReturn.srNumber} against SI ${salesReturn.siNumber || ""}`,
    lines: [
      {
        ledgerId: salesLedger._id,
        ledgerName: salesLedger.name,
        debit: base,
        credit: 0,
        description: "Sales reversal (returns)",
      },
      {
        ledgerId: outputTaxLedger._id,
        ledgerName: outputTaxLedger.name,
        debit: tax,
        credit: 0,
        description: "Output tax reversal",
      },
      {
        ledgerId: arLedger._id,
        ledgerName: arLedger.name,
        debit: 0,
        credit: total,
        description: `Customer credit - ${salesReturn.customerName || ""}`,
      },
    ],
    totalDebit: base + tax,
    totalCredit: total,
    status: STATUS.POSTED,
    postedAt: new Date(),
    postedBy: userId || salesReturn.postedBy,
    createdBy: salesReturn.createdBy,
  });

  await Promise.all([
    applyLedgerDelta(salesLedger, base, 0),
    applyLedgerDelta(outputTaxLedger, tax, 0),
    applyLedgerDelta(arLedger, 0, total),
  ]);

  return voucher;
};

// Post sales return: update roll statuses + auto voucher
const postSalesReturn = handleAsyncErrors(async (req, res) => {
  const updated = await SalesReturn.findOneAndUpdate(
    { _id: req.params.id, status: STATUS.DRAFT },
    { status: STATUS.POSTED, postedAt: new Date(), postedBy: req.user?._id || undefined },
    { new: true }
  );

  let salesReturn = updated;
  if (!salesReturn) {
    salesReturn = await SalesReturn.findById(req.params.id);
    if (!salesReturn) {
      throw new AppError("Sales return not found", 404, "RESOURCE_NOT_FOUND");
    }
    if (salesReturn.status !== STATUS.POSTED) {
      throw new AppError("Only draft sales returns can be posted", 400, "INVALID_STATE_TRANSITION");
    }
  }

  // Compute taxable base from stored lines (tax reversal must mirror SI exactly)
  const taxableBase = (salesReturn.lines || []).reduce((sum, line = {}) => {
    const { qty, rate } = resolveRatePerRollFromLine(line);
    const discountPct = toNumber(line.discountLine);
    const lineSubtotal = qty * rate;
    const lineDiscount = lineSubtotal * (discountPct / 100);
    return sum + (lineSubtotal - lineDiscount);
  }, 0);

  // Update roll statuses to Returned
  const rollIds = (salesReturn.lines || []).map((l) => l.rollId).filter(Boolean);
  if (rollIds.length) {
    await Roll.updateMany(
      { _id: { $in: rollIds } },
      {
        $set: {
          status: "Returned",
          "returnDetails.returnReason": salesReturn.reason || "Sales return",
          "returnDetails.returnedAt": new Date(),
        },
      }
    );
  }

  // Always ensure voucher exists for posted return
  if (salesReturn.status === STATUS.POSTED) {
    const voucher = await ensureSalesReturnVoucher(salesReturn, taxableBase, req.user?._id);
    if (voucher && !salesReturn.voucherId) {
      salesReturn.voucherId = voucher._id;
      await salesReturn.save();
    }
  }

  res.json({ success: true, data: salesReturn });
});

// Cancel a draft sales return (no accounting/stock effect)
const cancelSalesReturn = handleAsyncErrors(async (req, res) => {
  const row = await SalesReturn.findById(req.params.id);
  if (!row) throw new AppError("Sales return not found", 404, "RESOURCE_NOT_FOUND");

  if (row.status === STATUS.CANCELLED) {
    return res.json({ success: true, data: row });
  }
  if (row.status !== STATUS.DRAFT) {
    throw new AppError("Only draft sales returns can be cancelled", 400, "INVALID_STATE_TRANSITION");
  }

  row.status = STATUS.CANCELLED;
  row.cancelReason = req.body?.reason;
  row.cancelledAt = new Date();
  row.cancelledBy = req.user?._id || undefined;
  await row.save();

  res.json({ success: true, data: row });
});

module.exports = {
  getSalesReturns,
  getSalesReturn,
  createSalesReturn,
  postSalesReturn,
  cancelSalesReturn,
};

