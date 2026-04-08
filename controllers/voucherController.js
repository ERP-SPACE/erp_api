const Voucher = require("../models/Voucher");
const Ledger = require("../models/Ledger");
const numberingService = require("../services/numberingService");
const { STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const getVouchers = handleAsyncErrors(async (req, res) => {
  const { voucherType, status, dateFrom, dateTo } = req.query;

  const filter = {};
  if (voucherType) filter.voucherType = voucherType;
  if (status) filter.status = status;
  if (dateFrom || dateTo) {
    filter.date = {};
    if (dateFrom) filter.date.$gte = new Date(dateFrom);
    if (dateTo) filter.date.$lte = new Date(dateTo);
  }

  const vouchers = await Voucher.find(filter).sort({ createdAt: -1 });

  res.json({
    success: true,
    count: vouchers.length,
    data: vouchers,
  });
});

const getVoucher = handleAsyncErrors(async (req, res) => {
  const voucher = await Voucher.findById(req.params.id)
    .populate("lines.ledgerId", "name ledgerCode group");

  if (!voucher) {
    throw new AppError("Voucher not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({ success: true, data: voucher });
});

const createVoucher = handleAsyncErrors(async (req, res) => {
  const { voucherType, date, entries = [], notes } = req.body;

  if (!voucherType) {
    throw new AppError("Voucher type is required", 400, "VALIDATION_ERROR");
  }
  if (!entries.length) {
    throw new AppError("At least one entry is required", 400, "VALIDATION_ERROR");
  }

  // Validate debit = credit
  const totalDebit = entries.filter((e) => e.type === "Debit").reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalCredit = entries.filter((e) => e.type === "Credit").reduce((s, e) => s + Number(e.amount || 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AppError("Debit and Credit totals must match", 400, "VALIDATION_ERROR");
  }

  const voucherNumber = await numberingService.generateNumber("VCH", Voucher, "voucherNumber");

  // Map entries to lines format (debit/credit fields instead of type/amount)
  const lines = entries.map((e) => ({
    ledgerId: e.ledgerId,
    ledgerName: e.ledgerName,
    debit: e.type === "Debit" ? Number(e.amount || 0) : 0,
    credit: e.type === "Credit" ? Number(e.amount || 0) : 0,
    description: e.narration || "",
  }));

  const voucher = await Voucher.create({
    voucherNumber,
    voucherType,
    date: date ? new Date(date) : new Date(),
    lines,
    // Keep entries array for frontend compatibility
    entries,
    debitTotal: totalDebit,
    creditTotal: totalCredit,
    totalDebit,
    totalCredit,
    notes,
    status: STATUS.DRAFT,
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: voucher });
});

const updateVoucher = handleAsyncErrors(async (req, res) => {
  const voucher = await Voucher.findById(req.params.id);

  if (!voucher) {
    throw new AppError("Voucher not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (voucher.status !== STATUS.DRAFT) {
    throw new AppError("Only draft vouchers can be edited", 400, "INVALID_STATE_TRANSITION");
  }

  const { voucherType, date, entries = [], notes } = req.body;

  const totalDebit = entries.filter((e) => e.type === "Debit").reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalCredit = entries.filter((e) => e.type === "Credit").reduce((s, e) => s + Number(e.amount || 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AppError("Debit and Credit totals must match", 400, "VALIDATION_ERROR");
  }

  const lines = entries.map((e) => ({
    ledgerId: e.ledgerId,
    ledgerName: e.ledgerName,
    debit: e.type === "Debit" ? Number(e.amount || 0) : 0,
    credit: e.type === "Credit" ? Number(e.amount || 0) : 0,
    description: e.narration || "",
  }));

  if (voucherType) voucher.voucherType = voucherType;
  if (date) voucher.date = new Date(date);
  voucher.lines = lines;
  voucher.entries = entries;
  voucher.debitTotal = totalDebit;
  voucher.creditTotal = totalCredit;
  voucher.totalDebit = totalDebit;
  voucher.totalCredit = totalCredit;
  voucher.notes = notes;

  await voucher.save();

  res.json({ success: true, data: voucher });
});

const deleteVoucher = handleAsyncErrors(async (req, res) => {
  const voucher = await Voucher.findById(req.params.id);

  if (!voucher) {
    throw new AppError("Voucher not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (voucher.status !== STATUS.DRAFT) {
    throw new AppError("Only draft vouchers can be deleted", 400, "INVALID_STATE_TRANSITION");
  }

  await Voucher.findByIdAndDelete(req.params.id);

  res.json({ success: true, message: "Voucher deleted successfully" });
});

const postVoucher = handleAsyncErrors(async (req, res) => {
  const updated = await Voucher.findOneAndUpdate(
    { _id: req.params.id, status: STATUS.DRAFT },
    { status: STATUS.POSTED, postedAt: new Date(), postedBy: req.user?._id },
    { new: true }
  );

  if (!updated) {
    const existing = await Voucher.findById(req.params.id);
    if (!existing) throw new AppError("Voucher not found", 404, "RESOURCE_NOT_FOUND");
    if (existing.status === STATUS.POSTED) {
      return res.json({ success: true, data: existing, message: "Already posted" });
    }
    throw new AppError("Only draft vouchers can be posted", 400, "INVALID_STATE_TRANSITION");
  }

  // Update ledger balances for each line
  for (const line of updated.lines || []) {
    if (!line.ledgerId) continue;
    const ledger = await Ledger.findById(line.ledgerId);
    if (!ledger) continue;
    const increaseOnDebit = ["Assets", "Expenses"].includes(ledger.group);
    const delta = increaseOnDebit
      ? (line.debit || 0) - (line.credit || 0)
      : (line.credit || 0) - (line.debit || 0);
    ledger.currentBalance = (Number(ledger.currentBalance) || 0) + delta;
    await ledger.save();
  }

  res.json({ success: true, data: updated });
});

module.exports = {
  getVouchers,
  getVoucher,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  postVoucher,
};
