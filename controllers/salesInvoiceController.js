const SalesInvoice = require("../models/SalesInvoice");
const DeliveryChallan = require("../models/DeliveryChallan");
const numberingService = require("../services/numberingService");
const { STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

/** Tax-exclusive rate per roll when missing: derive from tax-inclusive lineTotal. */
function resolveInvoiceLineRatePerRoll(line) {
  const qty = Number(line.qtyRolls) || 0;
  let rate = Number(line.ratePerRoll) || 0;
  if (rate > 0 && qty >= 0) return { qty: qty || 1, rate };

  const q = qty > 0 ? qty : 1;
  const lt = Number(line.lineTotal);
  if (lt > 0) {
    const taxRate = Number(line.taxRate) || 0;
    const discountPct = Number(line.discountLine) || 0;
    const taxableFromTotal = taxRate > 0 ? lt / (1 + taxRate / 100) : lt;
    const factor = q * (1 - discountPct / 100);
    rate = factor > 0 ? taxableFromTotal / factor : 0;
  }
  return { qty: q, rate };
}

// List invoices with basic filters
const getSalesInvoices = handleAsyncErrors(async (req, res) => {
  const { status, customerId, salesOrderId, dateFrom, dateTo } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (customerId) filter.customerId = customerId;
  if (salesOrderId) filter.salesOrderId = salesOrderId;
  if (dateFrom || dateTo) {
    filter.siDate = {};
    if (dateFrom) filter.siDate.$gte = new Date(dateFrom);
    if (dateTo) filter.siDate.$lte = new Date(dateTo);
  }

  const invoices = await SalesInvoice.find(filter)
    .populate("customerId", "name customerCode")
    .populate("salesOrderId", "soNumber")
    .populate("deliveryChallanId", "dcNumber")
    .sort({ createdAt: -1 });

  res.json({
    success: true,
    count: invoices.length,
    data: invoices,
  });
});

// Get single invoice
const getSalesInvoice = handleAsyncErrors(async (req, res) => {
  const invoice = await SalesInvoice.findById(req.params.id)
    .populate("customerId", "name customerCode")
    .populate("salesOrderId", "soNumber")
    .populate("deliveryChallanId", "dcNumber");

  if (!invoice) {
    throw new AppError("Sales invoice not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({
    success: true,
    data: invoice,
  });
});

// Create invoice (draft)
const createSalesInvoice = handleAsyncErrors(async (req, res) => {
  const {
    deliveryChallanId,
    salesOrderId,
    customerId,
    customerName,
    siDate,
    dueDate,
    lines = [],
    paymentStatus = "Unpaid",
    paidAmount = 0,
    outstandingAmount,
  } = req.body;

  if (!salesOrderId) {
    throw new AppError("Sales order is required", 400, "VALIDATION_ERROR");
  }
  if (!customerId || !customerName) {
    throw new AppError("Customer is required", 400, "VALIDATION_ERROR");
  }

  // Check if customer is blocked
  const Customer = require("../models/Customer");
  const customer = await Customer.findById(customerId).select("companyName creditPolicy");
  if (!customer) {
    throw new AppError("Customer not found", 404, "RESOURCE_NOT_FOUND");
  }
  if (customer.creditPolicy?.isBlocked) {
    const blockReason = customer.creditPolicy.blockReason || "Customer is blocked";
    throw new AppError(
      `Cannot create sales invoice: ${customer.companyName} is blocked. Reason: ${blockReason}`,
      400,
      "CUSTOMER_BLOCKED"
    );
  }

  const siNumber = await numberingService.generateNumber("SI", SalesInvoice);

  let subtotal = 0;
  let taxAmount = 0;
  let totalCOGS = 0;

  const processedLines = (lines || []).map((line) => {
    const { qty, rate } = resolveInvoiceLineRatePerRoll(line);
    const discountPct = Number(line.discountLine) || 0;
    const taxRate = Number(line.taxRate) || 0;
    const lineSubtotal = qty * rate;
    const lineDiscount = lineSubtotal * (discountPct / 100);
    const taxableAmount = lineSubtotal - lineDiscount;
    const lineTax = taxableAmount * (taxRate / 100);

    subtotal += lineSubtotal;
    taxAmount += lineTax;
    totalCOGS += Number(line.cogsAmount) || 0;

    return {
      ...line,
      qtyRolls: qty,
      ratePerRoll: rate,
      discountLine: discountPct,
      taxRate,
      lineTotal: taxableAmount + lineTax,
    };
  });

  const total = subtotal + taxAmount;
  const grossMargin = total - totalCOGS;
  const normalizedPaid = Number(paidAmount) || 0;
  const outstanding = outstandingAmount ?? total - normalizedPaid;

  const salesInvoice = await SalesInvoice.create({
    siNumber,
    salesOrderId,
    deliveryChallanId: deliveryChallanId || undefined,
    customerId,
    customerName,
    siDate: siDate ? new Date(siDate) : new Date(),
    dueDate: dueDate ? new Date(dueDate) : undefined,
    status: STATUS.DRAFT,
    lines: processedLines,
    subtotal,
    taxAmount,
    total,
    totalCOGS,
    grossMargin,
    paymentStatus,
    paidAmount: normalizedPaid,
    outstandingAmount: outstanding,
    createdBy: req.user?._id || undefined,
  });

  // Mark the delivery challan as invoiced if provided
  if (deliveryChallanId) {
    await DeliveryChallan.findByIdAndUpdate(deliveryChallanId, {
      invoicedInSIId: salesInvoice._id,
      invoicedAt: new Date(),
    });
  }

  const populatedInvoice = await SalesInvoice.findById(salesInvoice._id)
    .populate("customerId", "name customerCode")
    .populate("salesOrderId", "soNumber")
    .populate("deliveryChallanId", "dcNumber");

  res.status(201).json({
    success: true,
    data: populatedInvoice,
  });
});

// Post an invoice (mark as finalized)
const postSalesInvoice = handleAsyncErrors(async (req, res) => {
  const invoice = await SalesInvoice.findById(req.params.id);
  if (!invoice) {
    throw new AppError("Sales invoice not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (invoice.status === STATUS.POSTED) {
    return res.json({ success: true, data: invoice });
  }

  invoice.status = STATUS.POSTED;
  invoice.postedAt = new Date();
  invoice.postedBy = req.user?._id || undefined;

  await invoice.save();

  res.json({
    success: true,
    data: invoice,
  });
});

module.exports = {
  getSalesInvoices,
  getSalesInvoice,
  createSalesInvoice,
  postSalesInvoice,
};
