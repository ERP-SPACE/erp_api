const mongoose = require("mongoose");
const { STATUS } = require("../config/constants");

const salesReturnLineSchema = new mongoose.Schema(
  {
    rollId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Roll",
      required: true,
    },
    rollNumber: {
      type: String,
      required: true,
    },
    siLineRollId: {
      // The rollId as stored on the originating sales invoice line (for traceability)
      type: mongoose.Schema.Types.ObjectId,
    },
    skuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SKU",
    },
    categoryName: String,
    gsm: String,
    qualityName: String,
    widthInches: Number,
    billedLengthMeters: Number,
    qtyRolls: {
      type: Number,
      default: 1,
    },
    ratePerRoll: Number,
    discountLine: {
      type: Number,
      default: 0,
    },
    taxRate: Number,
    lineTotal: Number,
    cogsAmount: Number,
  },
  { _id: false }
);

const salesReturnSchema = new mongoose.Schema(
  {
    srNumber: {
      type: String,
      unique: true,
      required: true,
    },
    salesInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesInvoice",
      required: true,
      index: true,
    },
    siNumber: String,
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    customerName: {
      type: String,
      required: true,
    },
    srDate: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: [STATUS.DRAFT, STATUS.POSTED, STATUS.CANCELLED],
      default: STATUS.DRAFT,
      index: true,
    },
    reason: String,
    lines: [salesReturnLineSchema],
    subtotal: Number,
    discountTotal: {
      type: Number,
      default: 0,
    },
    taxAmount: Number,
    total: Number,
    voucherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Voucher",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    postedAt: Date,
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true }
);

salesReturnSchema.index({ srNumber: 1 });
salesReturnSchema.index({ salesInvoiceId: 1, status: 1 });
salesReturnSchema.index({ customerId: 1, status: 1 });

module.exports = mongoose.model("SalesReturn", salesReturnSchema);

