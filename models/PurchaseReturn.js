const mongoose = require("mongoose");
const { STATUS } = require("../config/constants");

const purchaseReturnLineSchema = new mongoose.Schema(
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
    skuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SKU",
    },
    skuCode: String,
    categoryName: String,
    gsm: String,
    qualityName: String,
    widthInches: Number,
    lengthMeters: Number,
    ratePerMeter: Number,
    taxRate: Number,
    lineBaseTotal: Number,
    lineTax: Number,
    lineTotal: Number,
    hsnCode: String,
    poLineId: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const purchaseReturnSchema = new mongoose.Schema(
  {
    prNumber: {
      type: String,
      unique: true,
      required: true,
    },
    purchaseInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseInvoice",
      required: true,
      index: true,
    },
    piNumber: String,
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    supplierName: {
      type: String,
      required: true,
    },
    prDate: {
      type: Date,
      default: Date.now,
    },
    gstMode: {
      type: String,
      enum: ["intra", "inter"],
      default: "intra",
    },
    sgst: {
      type: Number,
      default: 0,
    },
    cgst: {
      type: Number,
      default: 0,
    },
    igst: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: [STATUS.DRAFT, STATUS.POSTED, STATUS.CANCELLED],
      default: STATUS.DRAFT,
      index: true,
    },
    reason: String,
    lines: [purchaseReturnLineSchema],
    subtotal: Number,
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

purchaseReturnSchema.index({ prNumber: 1 });
purchaseReturnSchema.index({ purchaseInvoiceId: 1, status: 1 });
purchaseReturnSchema.index({ supplierId: 1, status: 1 });

module.exports = mongoose.model("PurchaseReturn", purchaseReturnSchema);

