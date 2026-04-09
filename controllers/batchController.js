const Batch = require("../models/Batch");
const Roll = require("../models/Roll");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const getBatches = handleAsyncErrors(async (req, res) => {
  const { supplierId, purchaseInvoiceId, search, dateFrom, dateTo } = req.query;

  const filter = {};
  if (supplierId) filter.supplierId = supplierId;
  if (purchaseInvoiceId) filter.purchaseInvoiceId = purchaseInvoiceId;
  if (search) filter.batchCode = { $regex: search, $options: "i" };
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  const batches = await Batch.find(filter)
    .populate("supplierId", "name supplierCode")
    .populate("purchaseInvoiceId", "piNumber supplierName")
    .sort({ createdAt: -1 });

  res.json({
    success: true,
    count: batches.length,
    data: batches,
  });
});

const getBatch = handleAsyncErrors(async (req, res) => {
  const batch = await Batch.findById(req.params.id)
    .populate("supplierId", "name supplierCode")
    .populate("purchaseInvoiceId", "piNumber supplierName");

  if (!batch) {
    throw new AppError("Batch not found", 404, "RESOURCE_NOT_FOUND");
  }

  const rollCount = await Roll.countDocuments({ batchId: batch._id });
  if (rollCount !== batch.totalRolls) {
    batch.totalRolls = rollCount;
    await batch.save();
  }

  res.json({
    success: true,
    data: batch,
  });
});

const createBatch = handleAsyncErrors(async (req, res) => {
  const { supplierId, purchaseInvoiceId, batchCode, manufactureDate, expiryDate, notes } = req.body;

  if (!supplierId) {
    throw new AppError("supplierId is required", 400, "VALIDATION_ERROR");
  }

  const payload = {
    supplierId,
    purchaseInvoiceId: purchaseInvoiceId || undefined,
    batchCode: batchCode || undefined,
    manufactureDate: manufactureDate ? new Date(manufactureDate) : undefined,
    expiryDate: expiryDate ? new Date(expiryDate) : undefined,
    notes,
  };

  const batch = await Batch.create(payload);
  const populatedBatch = await Batch.findById(batch._id)
    .populate("supplierId", "name supplierCode")
    .populate("purchaseInvoiceId", "piNumber supplierName");

  res.status(201).json({
    success: true,
    data: populatedBatch,
  });
});

module.exports = {
  getBatches,
  getBatch,
  createBatch,
};
