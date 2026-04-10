const DeliveryChallan = require("../models/DeliveryChallan");
const SalesOrder = require("../models/SalesOrder");
const Roll = require("../models/Roll");
const numberingService = require("../services/numberingService");
const { STATUS } = require("../config/constants");
const { handleAsyncErrors, AppError } = require("../utils/errorHandler");

const dcPopulate = [
  {
    path: "salesOrderId",
    select: "soNumber customerName status",
  },
  {
    path: "lines.rollId",
    select: "rollNumber status currentLengthMeters widthInches",
  },
];

const findAndPopulateDC = async (id) => {
  return DeliveryChallan.findById(id).populate(dcPopulate);
};

const recomputeSalesOrderFulfillmentStatus = (salesOrder) => {
  const totalQty = (salesOrder.lines || []).reduce(
    (sum, l) => sum + (Number(l.qtyRolls) || 0),
    0
  );
  const dispatchedQty = (salesOrder.lines || []).reduce(
    (sum, l) => sum + (Number(l.dispatchedQty) || 0),
    0
  );

  if (dispatchedQty >= totalQty && totalQty > 0) {
    salesOrder.status = STATUS.CLOSED;
  } else if (dispatchedQty > 0) {
    salesOrder.status = STATUS.PARTIALLY_FULFILLED;
  }
};

// Get all delivery challans with basic filters
const getDeliveryChallans = handleAsyncErrors(async (req, res) => {
  const { status, salesOrderId, customerId } = req.query;

  const filter = {};
  if (status) {
    const statuses = Array.isArray(status)
      ? status
      : String(status)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (salesOrderId) filter.salesOrderId = salesOrderId;
  if (customerId) filter.customerId = customerId;

  const challans = await DeliveryChallan.find(filter)
    .populate(dcPopulate)
    .sort({ createdAt: -1 });

  res.json({
    success: true,
    count: challans.length,
    data: challans,
  });
});

// Get single delivery challan
const getDeliveryChallan = handleAsyncErrors(async (req, res) => {
  const challan = await findAndPopulateDC(req.params.id);

  if (!challan) {
    throw new AppError("Delivery challan not found", 404, "RESOURCE_NOT_FOUND");
  }

  res.json({
    success: true,
    data: challan,
  });
});

// Create delivery challan draft (no stock impact)
const createDeliveryChallan = handleAsyncErrors(async (req, res) => {
  const {
    salesOrderId,
    dcDate = new Date(),
    vehicleNumber,
    driverName,
    driverPhone,
    lines = [],
    notes,
  } = req.body;

  const salesOrder = await SalesOrder.findById(salesOrderId);
  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  // Check if customer is blocked
  const Customer = require("../models/Customer");
  const customer = await Customer.findById(salesOrder.customerId).select("companyName creditPolicy");
  if (customer?.creditPolicy?.isBlocked) {
    const blockReason = customer.creditPolicy.blockReason || "Customer is blocked";
    throw new AppError(
      `Cannot create delivery challan: ${customer.companyName} is blocked. Reason: ${blockReason}`,
      400,
      "CUSTOMER_BLOCKED"
    );
  }

  const dcNumber = await numberingService.generateFiscalYearNumber(
    "DC",
    DeliveryChallan,
    "dcNumber",
    dcDate
  );

  // Validate lines (draft stores planned rollIds but does not change Roll/SO)
  const processedLines = [];
  for (const line of lines) {
    const roll = await Roll.findById(line.rollId);
    if (!roll) {
      throw new AppError(`Roll not found: ${line.rollId}`, 404, "RESOURCE_NOT_FOUND");
    }

    const soLine =
      salesOrder.lines.id(line.soLineId) ||
      salesOrder.lines.find(
        (l) => l._id?.toString() === line.soLineId?.toString()
      );

    if (!soLine) {
      throw new AppError(
        `SO line not found for roll ${roll.rollNumber}`,
        400,
        "VALIDATION_ERROR"
      );
    }

    if (!["Mapped", "Allocated"].includes(roll.status)) {
      throw new AppError(
        `Roll ${roll.rollNumber} is not available for dispatch (status: ${roll.status})`,
        400,
        "INVALID_ROLL_STATUS"
      );
    }

    processedLines.push({
      soLineId: line.soLineId || null,
      rollId: roll._id,
      rollNumber: roll.rollNumber,
      skuId: roll.skuId,
      widthInches: roll.widthInches,
      shippedLengthMeters: line.shippedLengthMeters || roll.currentLengthMeters,
      shippedStatus: line.shippedStatus || "Packed",
    });
  }

  const challan = await DeliveryChallan.create({
    dcNumber,
    salesOrderId,
    soNumber: salesOrder.soNumber,
    customerId: salesOrder.customerId,
    customerName: salesOrder.customerName,
    dcDate,
    status: STATUS.DRAFT,
    lines: processedLines,
    vehicleNumber,
    driverName,
    driverPhone,
    notes,
    createdBy: req.user ? req.user._id : undefined,
  });

  const populated = await findAndPopulateDC(challan._id);

  res.status(201).json({
    success: true,
    data: populated,
  });
});

// Post delivery challan: mark rolls dispatched and update SO cumulative dispatched qty
const postDeliveryChallan = handleAsyncErrors(async (req, res) => {
  const challan = await DeliveryChallan.findById(req.params.id);

  if (!challan) {
    throw new AppError("Delivery challan not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (challan.status !== STATUS.DRAFT) {
    throw new AppError(
      "Only draft delivery challans can be posted",
      400,
      "INVALID_STATE_TRANSITION"
    );
  }

  const salesOrder = await SalesOrder.findById(challan.salesOrderId);
  if (!salesOrder) {
    throw new AppError("Sales order not found", 404, "RESOURCE_NOT_FOUND");
  }

  if (!Array.isArray(challan.lines) || challan.lines.length === 0) {
    throw new AppError(
      "Cannot post a delivery challan with no lines",
      400,
      "VALIDATION_ERROR"
    );
  }

  // Validate & apply dispatch
  for (const line of challan.lines) {
    const roll = await Roll.findById(line.rollId);
    if (!roll) {
      throw new AppError(`Roll not found: ${line.rollId}`, 404, "RESOURCE_NOT_FOUND");
    }

    if (!["Mapped", "Allocated"].includes(roll.status)) {
      throw new AppError(
        `Roll ${roll.rollNumber} is not available for dispatch (status: ${roll.status})`,
        400,
        "INVALID_ROLL_STATUS"
      );
    }

    // Update roll status & dispatch details
    await Roll.findByIdAndUpdate(
      roll._id,
      {
        status: "Dispatched",
        dispatchDetails: {
          dcId: challan._id,
          dispatchedAt: new Date(challan.dcDate),
          dispatchedBy: req.user ? req.user._id : undefined,
        },
      },
      { new: true }
    );

    // Update sales order line dispatched qty (1 per roll)
    const soLine =
      salesOrder.lines.id(line.soLineId) ||
      salesOrder.lines.find((l) => l._id?.toString() === line.soLineId?.toString());
    if (soLine) {
      soLine.dispatchedQty = (soLine.dispatchedQty || 0) + 1;
    }
  }

  recomputeSalesOrderFulfillmentStatus(salesOrder);
  await salesOrder.save();

  challan.status = STATUS.POSTED;
  // Mark all shippedStatus as Dispatched when posted
  (challan.lines || []).forEach((l) => {
    l.shippedStatus = "Dispatched";
  });
  await challan.save();

  const populated = await findAndPopulateDC(challan._id);
  res.json({ success: true, data: populated });
});

// Update delivery challan details (metadata only)
const updateDeliveryChallan = handleAsyncErrors(async (req, res) => {
  const challan = await DeliveryChallan.findById(req.params.id);

  if (!challan) {
    throw new AppError("Delivery challan not found", 404, "RESOURCE_NOT_FOUND");
  }

  // Do not allow line modifications after creation for now
  const updatableFields = [
    "dcDate",
    "vehicleNumber",
    "driverName",
    "driverPhone",
    "notes",
    "status",
  ];

  updatableFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      challan[field] = req.body[field];
    }
  });

  await challan.save();

  const populated = await findAndPopulateDC(challan._id);

  res.json({
    success: true,
    data: populated,
  });
});

// Close delivery challan
const closeDeliveryChallan = handleAsyncErrors(async (req, res) => {
  const challan = await DeliveryChallan.findById(req.params.id);

  if (!challan) {
    throw new AppError("Delivery challan not found", 404, "RESOURCE_NOT_FOUND");
  }

  challan.status = STATUS.CLOSED;
  challan.invoicedAt = challan.invoicedAt || new Date();
  await challan.save();

  const populated = await findAndPopulateDC(challan._id);

  res.json({
    success: true,
    data: populated,
  });
});

module.exports = {
  getDeliveryChallans,
  getDeliveryChallan,
  createDeliveryChallan,
  postDeliveryChallan,
  updateDeliveryChallan,
  closeDeliveryChallan,
};
