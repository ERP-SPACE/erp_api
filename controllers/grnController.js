const GRN = require("../models/GRN");
const PurchaseOrder = require("../models/PurchaseOrder");
const PurchaseInvoice = require("../models/PurchaseInvoice");
const Batch = require("../models/Batch");
const Roll = require("../models/Roll");
const Supplier = require("../models/Supplier");
const numberingService = require("../services/numberingService");
const { PURCHASE_ORDER_STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

// Get all GRNs
const getGRNs = handleAsyncErrors(async (req, res) => {
  const { status, purchaseOrderId, supplierId, dateFrom, dateTo } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (purchaseOrderId) filter.purchaseOrderId = purchaseOrderId;
  if (supplierId) filter.supplierId = supplierId;
  if (dateFrom || dateTo) {
    filter.date = {};
    if (dateFrom) filter.date.$gte = new Date(dateFrom);
    if (dateTo) filter.date.$lte = new Date(dateTo);
  }

  const grns = await GRN.find(filter)
    .populate("purchaseOrderId", "poNumber supplierName")
    .populate("supplierId", "name supplierCode")
    .sort({ createdAt: -1 });

  res.json({ success: true, count: grns.length, data: grns });
});

// Get single GRN
const getGRN = handleAsyncErrors(async (req, res) => {
  const grn = await GRN.findById(req.params.id)
    .populate("purchaseOrderId", "poNumber supplierName date lines")
    .populate("supplierId", "name supplierCode address");

  if (!grn) {
    throw new AppError("GRN not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({ success: true, data: grn });
});

// Create GRN
const createGRN = handleAsyncErrors(async (req, res) => {
  const { purchaseOrderId, lines, notes } = req.body;

  const purchaseOrder = await PurchaseOrder.findById(purchaseOrderId).populate(
    "supplierId",
    "name supplierCode"
  );
  if (!purchaseOrder) {
    throw new AppError("Purchase order not found", 404, "RESOURCE_NOT_FOUND");
  }

  // Guard: a Posted PI already provides rolls for this PO — block duplicate GRN creation.
  // Draft PIs are fine (GRN is an alternative inward, not a duplicate).
  const existingPostedPI = await PurchaseInvoice.findOne({
    purchaseOrderId,
    status: "Posted",
  });
  if (existingPostedPI) {
    throw new AppError(
      `A posted Purchase Invoice (${existingPostedPI.piNumber}) already exists for this PO. ` +
        "Use the PI workflow to inward goods.",
      400,
      "DUPLICATE_INWARD"
    );
  }

  if (
    purchaseOrder.poStatus === PURCHASE_ORDER_STATUS.CLOSED ||
    purchaseOrder.poStatus === PURCHASE_ORDER_STATUS.CANCELLED
  ) {
    throw new AppError(
      "Cannot create GRN for a closed or cancelled PO",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  const grnNumber = await numberingService.generateNumber("GRN", GRN);
  const supplier = purchaseOrder.supplierId; // already populated

  // Create a Batch record for this GRN inward
  const batch = new Batch({
    supplierId: supplier._id || supplier,
    notes: `GRN inward - ${grnNumber}`,
  });
  await batch.save(); // pre-save hook generates batchCode

  const processedLines = [];
  let rollSequence = 0;

  for (const line of lines) {
    const poLine = purchaseOrder.lines.id(line.poLineId);
    if (!poLine) {
      throw new AppError(
        `PO line not found: ${line.poLineId}`,
        400,
        "VALIDATION_ERROR"
      );
    }

    const qtyRolls = Number(line.qtyRolls ?? poLine.qtyRolls) || 0;
    const lengthMetersPerRoll =
      Number(line.lengthMetersPerRoll ?? poLine.lengthMetersPerRoll) || 0;

    // Create rolls one-by-one so the pre('save') hook generates barcode + qrCode
    for (let i = 0; i < qtyRolls; i++) {
      rollSequence++;
      const rollNumber = `${grnNumber}-R${String(rollSequence).padStart(4, "0")}`;

      const roll = new Roll({
        rollNumber,
        skuId: poLine.skuId || null,
        batchId: batch._id,
        supplierId: supplier._id || supplier,
        purchaseOrderId: purchaseOrder._id,
        categoryName: poLine.categoryName,
        gsm: poLine.gsm,
        qualityName: poLine.qualityName,
        widthInches: poLine.widthInches,
        originalLengthMeters: lengthMetersPerRoll,
        currentLengthMeters: lengthMetersPerRoll,
        // Start as Mapped if SKU known; Unmapped otherwise
        status: poLine.skuId ? "Mapped" : "Unmapped",
        poLineId: poLine._id,
      });

      await roll.save();
    }

    processedLines.push({
      poLineId: poLine._id,
      skuId: poLine.skuId,
      skuCode: poLine.skuCode,
      categoryName: poLine.categoryName,
      gsm: poLine.gsm,
      qualityName: poLine.qualityName,
      widthInches: poLine.widthInches,
      lengthMetersPerRoll: poLine.lengthMetersPerRoll,
      qtyRolls: poLine.qtyRolls,
      receivedQtyRolls: qtyRolls,
      totalMeters: qtyRolls * lengthMetersPerRoll,
      ratePerRoll: poLine.ratePerRoll,
      lineTotal: poLine.lineTotal,
    });
  }

  const grn = await GRN.create({
    grnNumber,
    purchaseOrderId,
    poNumber: purchaseOrder.poNumber,
    supplierId: supplier._id || supplier,
    supplierName: purchaseOrder.supplierName || supplier.name,
    batchId: batch._id,
    lines: processedLines,
    notes,
    createdBy: req.user ? req.user._id : undefined,
  });

  // Update PO received quantities and status
  let allLinesReceived = true;
  let anyLineReceived = false;

  for (const line of processedLines) {
    const poLine = purchaseOrder.lines.id(line.poLineId);
    if (!poLine) continue;

    poLine.receivedQty = (Number(poLine.receivedQty) || 0) + line.receivedQtyRolls;
    if (poLine.receivedQty < poLine.qtyRolls) {
      allLinesReceived = false;
    } else {
      anyLineReceived = true;
    }
  }

  if (allLinesReceived) {
    // All PO lines fully received → mark PO as Complete
    purchaseOrder.poStatus = PURCHASE_ORDER_STATUS.COMPLETE;
  } else if (anyLineReceived) {
    // Some lines partially received
    purchaseOrder.poStatus = PURCHASE_ORDER_STATUS.PARTIAL;
  }

  await purchaseOrder.save();

  // Keep batch roll count in sync
  const finalRollCount = await Roll.countDocuments({ batchId: batch._id });
  batch.totalRolls = finalRollCount;
  await batch.save();

  const populatedGRN = await GRN.findById(grn._id)
    .populate("purchaseOrderId", "poNumber supplierName")
    .populate("supplierId", "name supplierCode");

  res.status(201).json({ success: true, data: populatedGRN });
});

// Post GRN (finalize)
const postGRN = handleAsyncErrors(async (req, res) => {
  const grn = await GRN.findById(req.params.id);

  if (!grn) {
    throw new AppError("GRN not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (grn.status !== "Draft") {
    throw new AppError(
      "Only draft GRNs can be posted",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  grn.status = "Posted";
  grn.postedBy = req.user ? req.user._id : undefined;
  grn.postedAt = new Date();
  await grn.save();

  res.json({ success: true, data: grn });
});

module.exports = {
  getGRNs,
  getGRN,
  createGRN,
  postGRN,
};
