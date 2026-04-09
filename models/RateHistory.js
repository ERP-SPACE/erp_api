const mongoose = require("mongoose");

const rateHistorySchema = new mongoose.Schema(
  {
    rateHistoryId: {
      type: Number,
      unique: true,
    },
    baseRateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BaseRate",
      required: [true, "Base rate is required"],
    },
    skuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SKU",
      required: [true, "SKU is required"],
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      default: null,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    previousRate: {
      type: Number,
      required: [true, "Previous rate is required"],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
rateHistorySchema.index({ rateHistoryId: 1 });
rateHistorySchema.index({ baseRateId: 1 });
rateHistorySchema.index({ skuId: 1 });
rateHistorySchema.index({ supplierId: 1, createdAt: -1 });
rateHistorySchema.index({ agentId: 1, createdAt: -1 });
rateHistorySchema.index({ customerId: 1, createdAt: -1 });
rateHistorySchema.index({ supplierId: 1, skuId: 1, createdAt: -1 });
rateHistorySchema.index({ agentId: 1, skuId: 1, createdAt: -1 });
rateHistorySchema.index({ customerId: 1, skuId: 1, createdAt: -1 });

rateHistorySchema.pre("validate", function (next) {
  const hasSupplier = !!this.supplierId;
  const hasAgent = !!this.agentId;
  const hasCustomer = !!this.customerId;
  const count = [hasSupplier, hasAgent, hasCustomer].filter(Boolean).length;

  if (count === 0) {
    return next(
      new Error("One of supplierId, agentId, or customerId is required")
    );
  }

  if (count > 1) {
    return next(
      new Error(
        "Only one of supplierId, agentId, or customerId can have a value"
      )
    );
  }

  next();
});

// Auto-generate rateHistoryId
rateHistorySchema.pre("save", async function (next) {
  if (!this.rateHistoryId && this.isNew) {
    try {
      const lastDoc = await this.constructor
        .findOne()
        .sort({ rateHistoryId: -1 })
        .select("rateHistoryId");
      this.rateHistoryId = lastDoc ? lastDoc.rateHistoryId + 1 : 1;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Virtual to populate baseRate
rateHistorySchema.virtual("baseRate", {
  ref: "BaseRate",
  localField: "baseRateId",
  foreignField: "_id",
  justOne: true,
});

rateHistorySchema.virtual("sku", {
  ref: "SKU",
  localField: "skuId",
  foreignField: "_id",
  justOne: true,
});

rateHistorySchema.virtual("supplier", {
  ref: "Supplier",
  localField: "supplierId",
  foreignField: "_id",
  justOne: true,
});

rateHistorySchema.virtual("agent", {
  ref: "Agent",
  localField: "agentId",
  foreignField: "_id",
  justOne: true,
});

rateHistorySchema.virtual("customer", {
  ref: "Customer",
  localField: "customerId",
  foreignField: "_id",
  justOne: true,
});

module.exports = mongoose.model("RateHistory", rateHistorySchema);
