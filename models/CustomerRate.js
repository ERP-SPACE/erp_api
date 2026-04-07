const mongoose = require("mongoose");

const customerRateSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    // SKU-specific rate — width is baked in, no per-width derivation needed
    skuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SKU",
      required: true,
    },
    baseRate: {
      type: Number,
      required: true,
      min: 0,
    },
    validFrom: {
      type: Date,
      required: true,
      default: Date.now,
    },
    validTo: {
      type: Date,
      default: null,
    },
    isSpecialRate: {
      type: Boolean,
      default: false,
    },
    specialRateReason: String,
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    notes: String,
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
customerRateSchema.index({ customerId: 1, skuId: 1, active: 1, validFrom: -1 });
customerRateSchema.index({ customerId: 1, active: 1 });

customerRateSchema.statics.getActiveRate = async function (
  customerId,
  skuId,
  date = new Date()
) {
  return this.findOne({
    customerId,
    skuId,
    active: true,
    validFrom: { $lte: date },
    $or: [{ validTo: null }, { validTo: { $gte: date } }],
  }).sort({ validFrom: -1 });
};

module.exports = mongoose.model("CustomerRate", customerRateSchema);
