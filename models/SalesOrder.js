const mongoose = require("mongoose");
const { STATUS } = require("../config/constants");

const bifurcationGroupSchema = new mongoose.Schema(
  {
    qty: { type: Number, required: true },
    lengthMeters: { type: Number, required: true },
  },
  { _id: false }
);

// Per-roll detail produced by the allocation algorithm
const allocationRollSchema = new mongoose.Schema(
  {
    rollId: { type: mongoose.Schema.Types.ObjectId, ref: "Roll" },
    rollNumber: String,
    lengthMeters: Number,
  },
  { _id: false }
);

const salesOrderLineSchema = new mongoose.Schema({
  skuId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SKU",
    required: true,
  },
  categoryName: String,
  gsm: String,
  qualityName: String,
  widthInches: Number,
  lengthMetersPerRoll: Number,
  qtyRolls: Number,
  totalMeters: Number,
  // Manual bifurcation set by the user via the UI (qty × length groups)
  bifurcations: { type: [bifurcationGroupSchema], default: [] },
  // Advisory allocation computed from live inventory at order save time.
  // Does NOT lock rolls — physical locking happens at dispatch.
  allocation: { type: [allocationRollSchema], default: [] },
  allocationStatus: {
    type: String,
    enum: ["NOT_CHECKED", "FULFILLED", "PARTIAL", "NO_INVENTORY"],
    default: "NOT_CHECKED",
  },
  totalAllocatedMeters: { type: Number, default: 0 },
  remainingMeters: { type: Number, default: 0 },
  derivedRatePerRoll: Number,
  overrideRatePerRoll: Number,
  finalRatePerRoll: Number,
  taxRate: {
    type: Number,
    default: 18,
  },
  lineTotal: Number,
  allocatedQty: {
    type: Number,
    default: 0,
  },
  dispatchedQty: {
    type: Number,
    default: 0,
  },
  invoicedQty: {
    type: Number,
    default: 0,
  },
});

const salesOrderSchema = new mongoose.Schema(
  {
    soNumber: {
      type: String,
      unique: true,
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    customerName: {
      type: String,
      required: true,
    },
    customerGroup: [String],
    date: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: Object.values(STATUS),
      default: STATUS.DRAFT,
    },
    onHoldReason: String,
    lines: [salesOrderLineSchema],
    subtotal: Number,
    discountPercent: {
      type: Number,
      default: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },
    taxAmount: Number,
    total: Number,
    dueDays: {
      type: Number,
      default: null,
    },
    creditCheckPassed: Boolean,
    creditCheckNotes: String,
    overrideApprovals: [
      {
        lineId: mongoose.Schema.Types.ObjectId,
        reason: String,
        approvedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        approvedAt: Date,
      },
    ],
    notes: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    confirmedAt: Date,
  },
  {
    timestamps: true,
  }
);

// Indexes
salesOrderSchema.index({ soNumber: 1 });
salesOrderSchema.index({ customerId: 1 });
salesOrderSchema.index({ status: 1 });
salesOrderSchema.index({ date: 1 });

module.exports = mongoose.model("SalesOrder", salesOrderSchema);
