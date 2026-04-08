const Ledger = require("../models/Ledger");
const Voucher = require("../models/Voucher");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const getLedgers = handleAsyncErrors(async (req, res) => {
  const { group, active } = req.query;
  const filter = {};
  if (group) filter.group = group;
  if (active !== undefined) filter.active = active === "true";

  const ledgers = await Ledger.find(filter).sort({ group: 1, name: 1 });

  res.json({ success: true, count: ledgers.length, data: ledgers });
});

const getLedger = handleAsyncErrors(async (req, res) => {
  const ledger = await Ledger.findById(req.params.id);

  if (!ledger) {
    throw new AppError("Ledger not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({ success: true, data: ledger });
});

const createLedger = handleAsyncErrors(async (req, res) => {
  const { name, ledgerCode, group, description, openingBalance } = req.body;

  if (!name) throw new AppError("Name is required", 400, "VALIDATION_ERROR");
  if (!group) throw new AppError("Group is required", 400, "VALIDATION_ERROR");

  const ledger = await Ledger.create({
    name,
    ledgerCode,
    group,
    description,
    openingBalance: Number(openingBalance) || 0,
    currentBalance: Number(openingBalance) || 0,
    active: true,
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: ledger });
});

const updateLedger = handleAsyncErrors(async (req, res) => {
  const ledger = await Ledger.findByIdAndUpdate(
    req.params.id,
    { ...req.body },
    { new: true, runValidators: true }
  );

  if (!ledger) {
    throw new AppError("Ledger not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({ success: true, data: ledger });
});

// GET /ledgers/:id/transactions — all voucher lines affecting this ledger
const getLedgerTransactions = handleAsyncErrors(async (req, res) => {
  const { startDate, endDate } = req.query;

  const dateFilter = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate);

  const voucherFilter = { "lines.ledgerId": req.params.id, status: "Posted" };
  if (Object.keys(dateFilter).length) voucherFilter.date = dateFilter;

  const vouchers = await Voucher.find(voucherFilter).sort({ date: 1, createdAt: 1 });

  // Flatten to individual lines for this ledger, with running balance
  const ledger = await Ledger.findById(req.params.id);
  if (!ledger) throw new AppError("Ledger not found", 404, "RESOURCE_NOT_FOUND");

  let runningBalance = Number(ledger.openingBalance) || 0;
  const increaseOnDebit = ["Assets", "Expenses"].includes(ledger.group);

  const entries = [];
  for (const voucher of vouchers) {
    for (const line of voucher.lines || []) {
      if (line.ledgerId?.toString() !== req.params.id) continue;
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      const delta = increaseOnDebit ? debit - credit : credit - debit;
      runningBalance += delta;

      entries.push({
        date: voucher.date,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        narration: line.description || voucher.narration || "",
        debit,
        credit,
        runningBalance,
      });
    }
  }

  res.json({ success: true, count: entries.length, data: entries });
});

// GET /ledgers/:id/balance — summary totals + opening/closing balance
const getLedgerBalance = handleAsyncErrors(async (req, res) => {
  const { startDate, endDate } = req.query;

  const ledger = await Ledger.findById(req.params.id);
  if (!ledger) throw new AppError("Ledger not found", 404, "RESOURCE_NOT_FOUND");

  const dateFilter = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate);

  const voucherFilter = { "lines.ledgerId": req.params.id, status: "Posted" };
  if (Object.keys(dateFilter).length) voucherFilter.date = dateFilter;

  const vouchers = await Voucher.find(voucherFilter);

  let totalDebit = 0;
  let totalCredit = 0;

  for (const voucher of vouchers) {
    for (const line of voucher.lines || []) {
      if (line.ledgerId?.toString() !== req.params.id) continue;
      totalDebit += Number(line.debit) || 0;
      totalCredit += Number(line.credit) || 0;
    }
  }

  const openingBalance = Number(ledger.openingBalance) || 0;
  const increaseOnDebit = ["Assets", "Expenses"].includes(ledger.group);
  const netChange = increaseOnDebit ? totalDebit - totalCredit : totalCredit - totalDebit;
  const closingBalance = openingBalance + netChange;

  res.json({
    success: true,
    data: {
      openingBalance,
      totalDebit,
      totalCredit,
      balance: closingBalance,
    },
  });
});

module.exports = {
  getLedgers,
  getLedger,
  createLedger,
  updateLedger,
  getLedgerTransactions,
  getLedgerBalance,
};
