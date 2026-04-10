const mongoose = require("mongoose");
const { PURCHASE_ORDER_STATUS } = require("../config/constants");

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: {
      type: String,
      unique: true,
      required: true,
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
    date: {
      type: Date,
      default: Date.now,
    },
    expectedDeliveryDate: Date,
    supplierLeadTime: Number,
    poStatus: {
      type: String,
      enum: Object.values(PURCHASE_ORDER_STATUS),
      default: PURCHASE_ORDER_STATUS.DRAFT,
    },
    currency: {
      type: String,
      default: "INR",
    },
    lines: [
      {
        skuId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "SKU",
        },
        // Supplier benchmark base rate for 44" width (used to derive rate for other widths)
        baseRate44: {
          type: Number,
          default: 0,
        },
        // Derived rate based on width: baseRate44 * (widthInches / 44)
        derivedRatePerRoll: {
          type: Number,
          default: 0,
        },
        // Optional manual override of derivedRatePerRoll
        overrideRatePerRoll: {
          type: Number,
          default: null,
        },
        lineStatus: {
          type: String,
          enum: ["Pending", "Complete"],
          default: "Pending",
        },
        categoryName: String,
        gsm: String,
        qualityName: String,
        widthInches: Number,
        bifurcations: [
          {
            rollQty: { type: Number, default: 0 },
            metersPerRoll: { type: Number, default: 0 },
          },
        ],
        lengthMetersPerRoll: {
          type: Number,
          default: 0,
        },
        qtyRolls: Number,
        totalMeters: {
          type: Number,
          default: 0,
        },
        ratePerRoll: Number,
        lineTotal: Number,
        receivedQty: {
          type: Number,
          default: 0,
        },
        invoicedQty: {
          type: Number,
          default: 0,
        },
        receivedMeters: {
          type: Number,
          default: 0,
        },
      },
    ],
    subtotal: Number,
    totalAmount: Number,
    totalMeters: {
      type: Number,
      default: 0,
    },
    totalReceivedRolls: {
      type: Number,
      default: 0,
    },
    totalReceivedMeters: {
      type: Number,
      default: 0,
    },
    notes: String,
    closeReason: String,
    cancelReason: String,
    closedAt: Date,
    cancelledAt: Date,
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    lastReminderAt: Date,
    reminderCount: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedAt: Date,
  },
  {
    timestamps: true,
  }
);

// Indexes
purchaseOrderSchema.index({ poNumber: 1 });
purchaseOrderSchema.index({ supplierId: 1 });
purchaseOrderSchema.index({ poStatus: 1 });
purchaseOrderSchema.index({ date: 1 });

module.exports = mongoose.model("PurchaseOrder", purchaseOrderSchema);
