const mongoose = require("mongoose");
const rollService = require("../services/rollService");
const catchAsync = require("../utils/catchAsync");
const Roll = require("../models/Roll");
const AppError = require("../utils/AppError");

class RollController {
  createRolls = catchAsync(async (req, res) => {
    const rolls = req.body.rolls || req.body;
    const created = await rollService.createManualRolls(rolls);

    res.status(201).json({
      success: true,
      message: `${created.length} roll(s) created`,
      data: created,
    });
  });

  getAllRolls = catchAsync(async (req, res) => {
    const filters = {
      status: req.query.status,
      skuId: req.query.skuId,
      supplierId: req.query.supplierId,
      batchId: req.query.batchId,
      barcode: req.query.barcode,
      unmappedDays: req.query.unmappedDays
        ? parseInt(req.query.unmappedDays)
        : undefined,
    };

    const pagination = {
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await rollService.getAllRolls(filters, pagination);

    const formattedRolls = (result.rolls || []).map((roll) =>
      this.formatRollResponse(roll)
    );

    res.status(200).json({
      success: true,
      rolls: formattedRolls,
      pagination: result.pagination,
    });
  });

  getRollByBarcode = catchAsync(async (req, res) => {
    const roll = await rollService.getRollByBarcode(req.params.barcode);

    res.status(200).json({
      success: true,
      data: this.formatRollResponse(roll),
    });
  });

  getRoll = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid roll id", 400, "INVALID_ID");
    }

    const roll = await Roll.findById(id)
      .populate("skuId")
      .populate("supplierId")
      .populate("batchId");

    if (!roll) {
      throw new AppError("Roll not found", 404);
    }

    const formatted = this.formatRollResponse(roll);

    res.status(200).json({
      success: true,
      data: formatted,
    });
  });

  updateRoll = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid roll id", 400, "INVALID_ID");
    }

    const roll = await Roll.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    })
      .populate("skuId")
      .populate("supplierId")
      .populate("batchId");

    if (!roll) {
      throw new AppError("Roll not found", 404);
    }

    res.status(200).json({
      success: true,
      data: this.formatRollResponse(roll),
    });
  });

  getRollHistory = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid roll id", 400, "INVALID_ID");
    }

    const roll = await Roll.findById(id);

    if (!roll) {
      throw new AppError("Roll not found", 404);
    }

    const history = [
      {
        action: "Created",
        timestamp: roll.createdAt,
        details: roll.rollNumber,
      },
    ];

    if (roll.mappedAt) {
      history.push({
        action: "Mapped",
        timestamp: roll.mappedAt,
        details: `Status: ${roll.status}`,
      });
    }

    if (roll.allocationDetails?.allocatedAt) {
      history.push({
        action: "Allocated",
        timestamp: roll.allocationDetails.allocatedAt,
        details: `SO Line: ${roll.allocationDetails.soLineId}`,
      });
    }

    if (roll.dispatchDetails?.dispatchedAt) {
      history.push({
        action: "Dispatched",
        timestamp: roll.dispatchDetails.dispatchedAt,
        details: `DC: ${roll.dispatchDetails.dcId}`,
      });
    }

    if (roll.returnDetails?.returnedAt) {
      history.push({
        action: "Returned",
        timestamp: roll.returnDetails.returnedAt,
        details: roll.returnDetails.returnReason,
      });
    }

    if (roll.status === "Scrap") {
      history.push({
        action: "Scrapped",
        timestamp: roll.updatedAt || roll.createdAt,
        details: roll.notes,
      });
    }

    res.status(200).json({
      success: true,
      data: history,
    });
  });

  mapUnmappedRolls = catchAsync(async (req, res) => {
    const results = await rollService.mapUnmappedRolls(req.body.mappings);

    res.status(200).json({
      success: true,
      message: "Roll mapping completed",
      data: results,
    });
  });

  allocateRolls = catchAsync(async (req, res) => {
    const { soLineId, quantity } = req.body;
    const allocatedRolls = await rollService.allocateRollsToOrder(
      soLineId,
      quantity,
      req.userId
    );

    res.status(200).json({
      success: true,
      message: `${allocatedRolls.length} rolls allocated successfully`,
      data: allocatedRolls,
    });
  });

  deallocateRolls = catchAsync(async (req, res) => {
    const result = await rollService.deallocateRolls(req.body.soLineId);

    res.status(200).json({
      success: true,
      message: "Rolls deallocated successfully",
      data: result,
    });
  });

  dispatchRolls = catchAsync(async (req, res) => {
    const { dcId, rollIds } = req.body;
    const dispatchedRolls = await rollService.dispatchRolls(
      dcId,
      rollIds,
      req.userId
    );

    res.status(200).json({
      success: true,
      message: `${dispatchedRolls.length} rolls dispatched successfully`,
      data: dispatchedRolls,
    });
  });

  handleReturn = catchAsync(async (req, res) => {
    const { rollId, remainingMeters, reason } = req.body;
    const result = await rollService.handleReturn(
      rollId,
      remainingMeters,
      reason,
      req.userId
    );

    res.status(200).json({
      success: true,
      message: "Return processed successfully",
      data: result,
    });
  });

  markAsScrap = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid roll id", 400, "INVALID_ID");
    }

    const { reason } = req.body;
    const roll = await rollService.markAsScrap(id, reason, req.userId);

    res.status(200).json({
      success: true,
      message: "Roll marked as scrap",
      data: roll,
    });
  });

  getInventorySummary = catchAsync(async (req, res) => {
    // Accept an optional status filter (e.g. ?status=Mapped) to narrow the summary
    const statusFilter = req.query.status || null;
    const summary = await rollService.getInventorySummary(statusFilter);

    res.status(200).json({
      success: true,
      data: summary,
    });
  });

  getUnmappedRolls = catchAsync(async (req, res) => {
    // Return individual rolls (not grouped) so the UI can select/map them one-by-one.
    // Uses getAllRolls with status=Unmapped for a consistent, paginated response.
    const filters = { status: "Unmapped" };
    const pagination = { page: req.query.page || 1, limit: req.query.limit || 100 };

    const result = await rollService.getAllRolls(filters, pagination);

    const formattedRolls = (result.rolls || []).map((roll) =>
      this.formatRollResponse(roll)
    );

    res.status(200).json({
      success: true,
      count: result.pagination.total,
      data: formattedRolls,
      pagination: result.pagination,
    });
  });

  formatRollResponse(roll) {
    const obj = roll.toObject({ virtuals: true });
    return {
      ...obj,
      lengthMeters: obj.currentLengthMeters ?? obj.originalLengthMeters,
      supplierName:
        obj.supplierId?.supplierName ||
        obj.supplierId?.name ||
        obj.supplierId?.companyName ||
        obj.supplierId?.supplierCode,
      batchCode: obj.batchId?.batchCode || obj.batchId?.code,
      landedCostPerRoll: obj.landedCostPerMeter
        ? obj.landedCostPerMeter * (obj.currentLengthMeters || 0)
        : undefined,
    };
  }
}

module.exports = new RollController();
