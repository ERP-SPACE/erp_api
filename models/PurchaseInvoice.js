const mongoose = require("mongoose");
const { STATUS } = require("../config/constants");

const landedCostSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["Freight", "Duty", "Clearing", "Misc"],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  allocationBasis: {
    type: String,
    enum: ["ROLL", "METER", "VALUE"],
    required: true,
  },
  description: String,
});

const purchaseInvoiceSchema = new mongoose.Schema(
  {
    piNumber: {
      type: String,
      unique: true,
      required: true,
    },
    supplierInvoiceNumber: String,
    /** Set when the invoice is raised against a PO; omit or null for direct supplier bills (no PO). */
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      required: false,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    supplierName: {
      type: String,
      required: true,
    },
    supplierChallanNumber: String,
    lrNumber: String,
    lrDate: Date,
    caseNumber: String,
    hsnCode: String,
    date: {
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
    lines: [
      {
        poLineId: {
          // Allow manual lines that use string identifiers (e.g., "manual-123")
          type: mongoose.Schema.Types.Mixed,
        },
        poId: {
          type: mongoose.Schema.Types.Mixed,
        },
        poNumber: String,
        skuId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "SKU",
        },
        skuCode: String,
        categoryName: String,
        qualityName: String,
        gsm: String,
        widthInches: Number,
        lengthMetersPerRoll: Number,
        qtyRolls: Number,
        ratePerRoll: Number,
        taxRate: {
          type: Number,
          default: 18,
        },
        totalMeters: Number,
        lineTotal: Number,
        inwardRolls: Number,
        inwardMeters: Number,
        // One entry per physical roll received; source of truth for inventory.
        // Auto-generated from qtyRolls × lengthMetersPerRoll when not provided.
        rollDetails: [
          {
            lengthMeters: {
              type: Number,
              min: 0,
            },
          },
        ],
      },
    ],
    subtotal: Number,
    taxAmount: Number,
    total: Number,
    landedCosts: [landedCostSchema],
    totalLandedCost: Number,
    grandTotal: Number,
    status: {
      type: String,
      enum: [STATUS.DRAFT, STATUS.POSTED, STATUS.PAID],
      default: STATUS.DRAFT,
    },
    paymentStatus: {
      type: String,
      enum: ["Unpaid", "PartiallyPaid", "Paid"],
      default: "Unpaid",
    },
    paidAmount: {
      type: Number,
      default: 0,
    },
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
    notes: String,
  },
  {
    timestamps: true,
  }
);

// Indexes
purchaseInvoiceSchema.index({ piNumber: 1 });
purchaseInvoiceSchema.index({ supplierInvoiceNumber: 1 });
purchaseInvoiceSchema.index({ purchaseOrderId: 1 });
purchaseInvoiceSchema.index({ supplierId: 1 });
purchaseInvoiceSchema.index({ status: 1 });

module.exports = mongoose.model("PurchaseInvoice", purchaseInvoiceSchema);
