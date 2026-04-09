const Roll = require("../models/Roll");
const SKU = require("../models/SKU");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const mongoose = require("mongoose");
const numberingService = require("./numberingService");

class RollService {
  async mapUnmappedRolls(mappings) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const results = {
        success: [],
        failed: [],
      };

      for (const mapping of mappings) {
        try {
          const roll = await Roll.findById(mapping.rollId).session(session);

          if (!roll) {
            throw new Error(`Roll not found: ${mapping.rollId}`);
          }

          if (roll.status !== "Unmapped") {
            throw new Error(`Roll ${roll.barcode} is not unmapped`);
          }

          // Find product based on GSM and quality
          // First, find GSM and Quality by name
          const GSM = mongoose.model("GSM");
          const Quality = mongoose.model("Quality");
          
          const gsmName = mapping.gsm || roll.gsm;
          const qualityName = mapping.qualityName || roll.qualityGrade;
          
          const gsm = await GSM.findOne({ name: gsmName }).session(session);
          const quality = await Quality.findOne({ name: qualityName }).session(session);
          
          if (!gsm || !quality) {
            throw new Error(
              `GSM or Quality not found for GSM: ${gsmName}, Quality: ${qualityName}`
            );
          }
          
          let product = await Product.findOne({
            gsmId: gsm._id,
            qualityId: quality._id,
            categoryId: mapping.categoryId,
          }).session(session);

          if (!product) {
            throw new Error(
              `Product not found for GSM: ${gsmName}, Quality: ${qualityName}`
            );
          }

          // Find or create SKU
          let sku = await SKU.findOne({
            productId: product._id,
            widthInches: roll.widthInches,
          }).session(session);

          if (!sku) {
            sku = await SKU.create(
              [
                {
                  productId: product._id,
                  widthInches: roll.widthInches,
                },
              ],
              { session }
            );
            sku = sku[0];
          }

          // Update roll
          roll.skuId = sku._id;
          roll.status = "Mapped";
          roll.mappedAt = new Date();
          roll.gsm = mapping.gsm || roll.gsm;
          roll.qualityGrade = mapping.qualityName || roll.qualityGrade;

          await roll.save({ session });

          results.success.push({
            rollId: roll._id,
            barcode: roll.barcode,
            skuCode: sku.skuCode,
          });
        } catch (error) {
          results.failed.push({
            rollId: mapping.rollId,
            error: error.message,
          });
        }
      }

      await session.commitTransaction();
      return results;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async createManualRolls(rollsPayload = []) {
    if (!Array.isArray(rollsPayload) || !rollsPayload.length) {
      throw new AppError("No rolls provided", 400, "VALIDATION_ERROR");
    }

    const isValidObjectId = (val) =>
      mongoose.Types.ObjectId.isValid(val?.toString());

    const prepared = [];
    for (const [index, roll] of rollsPayload.entries()) {
      const supplierId = roll.supplierId;
      if (!supplierId) {
        throw new AppError("supplierId is required for roll creation", 400, "VALIDATION_ERROR");
      }

      const widthInches = Number(roll.widthInches);
      if (![24, 36, 44, 63].includes(widthInches)) {
        throw new AppError(
          `widthInches must be one of 24, 36, 44, 63 (got ${roll.widthInches})`,
          400,
          "VALIDATION_ERROR"
        );
      }

      const lengthMeters = Number(roll.lengthMeters) || Number(roll.originalLengthMeters) || 0;
      const currentLengthMeters = Number(roll.currentLengthMeters) || lengthMeters;

      let normalizedSkuId = null;
      let normalizedSkuCode = roll.skuCode;

      if (roll.skuId) {
        if (isValidObjectId(roll.skuId)) {
          normalizedSkuId = roll.skuId;
        } else {
          normalizedSkuCode = roll.skuCode || roll.skuId;
        }
      }

      const rollNumber =
        roll.rollNumber ||
        numberingService.generateRollNumber(
          supplierId.toString(),
          "MANUAL",
          Date.now() + index
        );

      prepared.push({
        rollNumber,
        skuId: normalizedSkuId,
        skuCode: normalizedSkuCode,
        categoryName: roll.categoryName,
        qualityName: roll.qualityName,
        gsm: roll.gsm,
        supplierId,
        batchId: roll.batchId || null,
        widthInches,
        originalLengthMeters: lengthMeters,
        currentLengthMeters,
        status: roll.status || "Unmapped",
        baseCostPerMeter: roll.baseCostPerMeter || 0,
        landedCostPerMeter: roll.landedCostPerMeter || 0,
        totalLandedCost: roll.totalLandedCost || 0,
        barcode: roll.barcode,
        poLineId: roll.poLineId,
      });
    }

    // Save individually so pre('save') hooks fire (barcode, qrCode generation)
    const created = [];
    for (const rollData of prepared) {
      const roll = new Roll(rollData);
      await roll.save();
      created.push(roll);
    }
    return created;
  }

  async getAllRolls(filters = {}, pagination = {}) {
    const query = {};

    // Apply filters
    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.skuId) {
      query.skuId = filters.skuId;
    }

    if (filters.supplierId) {
      query.supplierId = filters.supplierId;
    }

    if (filters.batchId) {
      query.batchId = filters.batchId;
    }

    if (filters.barcode) {
      query.barcode = { $regex: filters.barcode, $options: "i" };
    }

    // Unmapped aging filter
    if (filters.unmappedDays) {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - filters.unmappedDays);
      query.status = "Unmapped";
      query.inwardedAt = { $lte: daysAgo };
    }

    const page = parseInt(pagination.page) || 1;
    const limit = parseInt(pagination.limit) || 20;
    const skip = (page - 1) * limit;

    const [rolls, total] = await Promise.all([
      Roll.find(query)
        .populate("skuId")
        .populate("supplierId")
        .populate("batchId")
        .sort({ inwardedAt: -1 })
        .skip(skip)
        .limit(limit),
      Roll.countDocuments(query),
    ]);

    return {
      rolls,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getRollByBarcode(barcode) {
    const roll = await Roll.findOne({ barcode })
      .populate({
        path: "skuId",
        populate: {
          path: "product",
          populate: { path: "category" },
        },
      })
      .populate("supplierId")
      .populate("batchId");

    if (!roll) {
      throw new AppError("Roll not found", 404);
    }

    return roll;
  }

  async allocateRollsToOrder(soLineId, requiredQuantity, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const SalesOrderLine = require("../models/SalesOrderLine");
      const soLine = await SalesOrderLine.findById(soLineId).session(session);

      if (!soLine) {
        throw new AppError("Sales order line not found", 404);
      }

      // Find available rolls (FIFO)
      const availableRolls = await Roll.find({
        skuId: soLine.skuId,
        status: "Mapped",
        currentLengthMeters: { $gte: soLine.lengthPerRoll },
      })
        .sort({ inwardedAt: 1 })
        .limit(requiredQuantity)
        .session(session);

      if (availableRolls.length < requiredQuantity) {
        throw new AppError(
          `Insufficient stock. Available: ${availableRolls.length}, Required: ${requiredQuantity}`,
          400
        );
      }

      // Allocate rolls
      const allocatedRolls = [];
      for (const roll of availableRolls) {
        roll.status = "Allocated";
        roll.allocationDetails = {
          soLineId: soLineId,
          allocatedAt: new Date(),
          allocatedBy: userId,
        };
        await roll.save({ session });
        allocatedRolls.push(roll);
      }

      await session.commitTransaction();
      return allocatedRolls;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async deallocateRolls(soLineId) {
    const rolls = await Roll.updateMany(
      {
        "allocationDetails.soLineId": soLineId,
        status: "Allocated",
      },
      {
        $set: { status: "Mapped" },
        $unset: { allocationDetails: 1 },
      }
    );

    return rolls;
  }

  async dispatchRolls(dcId, rollIds, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const dispatchedRolls = [];

      for (const rollId of rollIds) {
        const roll = await Roll.findById(rollId).session(session);

        if (!roll) {
          throw new AppError(`Roll not found: ${rollId}`, 404);
        }

        if (roll.status !== "Allocated") {
          throw new AppError(`Roll ${roll.barcode} is not allocated`, 400);
        }

        roll.status = "Dispatched";
        roll.dispatchDetails = {
          dcId: dcId,
          dispatchedAt: new Date(),
          dispatchedBy: userId,
        };

        await roll.save({ session });
        dispatchedRolls.push(roll);
      }

      await session.commitTransaction();
      return dispatchedRolls;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async handleReturn(rollId, remainingMeters, reason, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const originalRoll = await Roll.findById(rollId).session(session);

      if (!originalRoll) {
        throw new AppError("Roll not found", 404);
      }

      // Mark original roll as returned
      originalRoll.status = "Returned";
      originalRoll.currentLengthMeters = 0;
      originalRoll.returnDetails = {
        returnReason: reason,
        returnedAt: new Date(),
      };
      await originalRoll.save({ session });

      // Create new roll for remaining meters if usable
      let newRoll = null;
      if (remainingMeters > 100) {
        // Minimum usable length
        newRoll = await Roll.create(
          [
            {
              skuId: originalRoll.skuId,
              batchId: originalRoll.batchId,
              supplierId: originalRoll.supplierId,
              widthInches: originalRoll.widthInches,
              originalLengthMeters: remainingMeters,
              currentLengthMeters: remainingMeters,
              status: "Mapped",
              landedCostPerMeter: originalRoll.landedCostPerMeter,
              returnDetails: {
                parentRollId: originalRoll._id,
                inspectionNotes: `Partial return from ${originalRoll.barcode}`,
              },
            },
          ],
          { session }
        );
        newRoll = newRoll[0];
      }

      await session.commitTransaction();
      return { originalRoll, newRoll };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async markAsScrap(rollId, reason, userId) {
    const roll = await Roll.findById(rollId);

    if (!roll) {
      throw new AppError("Roll not found", 404);
    }

    roll.status = "Scrap";
    roll.notes = reason;
    await roll.save();

    // Create accounting entry for inventory write-off
    // This will be handled by accounting service

    return roll;
  }

  async getInventorySummary(statusFilter = null) {
    const matchStage = statusFilter ? { $match: { status: statusFilter } } : null;

    const summary = await Roll.aggregate([
      ...(matchStage ? [matchStage] : []),
      {
        $lookup: {
          from: "skus",
          localField: "skuId",
          foreignField: "_id",
          as: "sku",
        },
      },
      { $unwind: { path: "$sku", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "products",
          localField: "sku.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "categories",
          localField: "product.categoryId",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "gsms",
          localField: "product.gsmId",
          foreignField: "_id",
          as: "gsm",
        },
      },
      { $unwind: { path: "$gsm", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "qualities",
          localField: "product.qualityId",
          foreignField: "_id",
          as: "quality",
        },
      },
      { $unwind: { path: "$quality", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            status: "$status",
            skuCode: "$sku.skuCode",
            categoryName: "$category.name",
            gsm: "$gsm.name",
            quality: "$quality.name",
            width: "$widthInches",
          },
          totalRolls: { $sum: 1 },
          totalMeters: { $sum: "$currentLengthMeters" },
          totalValue: { 
            $sum: { 
              $multiply: ["$landedCostPerMeter", "$currentLengthMeters"] 
            } 
          },
        },
      },
      {
        $sort: {
          "_id.status": 1,
          "_id.gsm": 1,
          "_id.quality": 1,
          "_id.width": 1,
        },
      },
    ]);

    // Get aging analysis
    const aging = await Roll.aggregate([
      {
        $match: { status: { $in: ["Mapped", "Unmapped"] } },
      },
      {
        $project: {
          status: 1,
          ageInDays: {
            $divide: [
              { $subtract: [new Date(), "$inwardedAt"] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$status",
          "0-30": {
            $sum: { $cond: [{ $lte: ["$ageInDays", 30] }, 1, 0] },
          },
          "31-60": {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ["$ageInDays", 30] },
                    { $lte: ["$ageInDays", 60] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          "61-90": {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ["$ageInDays", 60] },
                    { $lte: ["$ageInDays", 90] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          "90+": {
            $sum: { $cond: [{ $gt: ["$ageInDays", 90] }, 1, 0] },
          },
        },
      },
    ]);

    return { summary, aging };
  }

  async getUnmappedRolls() {
    const unmappedRolls = await Roll.find({ status: "Unmapped" })
      .populate("supplierId")
      .populate("batchId")
      .sort({ inwardedAt: 1 });

    const grouped = unmappedRolls.reduce((acc, roll) => {
      const key = `${roll.gsm || "Unknown"}-${roll.qualityGrade || "Unknown"}-${
        roll.widthInches
      }`;

      if (!acc[key]) {
        acc[key] = {
          gsm: roll.gsm,
          quality: roll.qualityGrade,
          width: roll.widthInches,
          rolls: [],
          totalRolls: 0,
          totalMeters: 0,
        };
      }

      acc[key].rolls.push(roll);
      acc[key].totalRolls++;
      acc[key].totalMeters += roll.currentLengthMeters;

      return acc;
    }, {});

    return Object.values(grouped);
  }
}

module.exports = new RollService();
