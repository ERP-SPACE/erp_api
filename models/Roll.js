const mongoose = require("mongoose");

const rollSchema = new mongoose.Schema(
  {
    rollNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    skuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SKU",
      default: null,
    },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    skuCode: String,
    categoryName: String,
    qualityName: String,
    widthInches: {
      type: Number,
      required: true,
      enum: [24, 36, 44, 63],
    },
    originalLengthMeters: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentLengthMeters: {
      type: Number,
      default: 0,
      min: 0,
    },
    gsm: String,
    qualityGrade: String,
    status: {
      type: String,
      enum: [
        "Unmapped",
        "Mapped",
        "Allocated",
        "Dispatched",
        "Returned",
        "Scrap",
      ],
      default: "Unmapped",
      required: true,
    },
    baseCostPerMeter: {
      type: Number,
      default: 0,
    },
    landedCostPerMeter: {
      type: Number,
      default: 0,
    },
    totalLandedCost: {
      type: Number,
      default: 0,
    },
    // Barcode - Format: YYMM-SUP-BATCH-SEQ-CHECK
    barcode: {
      type: String,
      required: false, // optional; will auto-generate when data available
      default: undefined, // avoid indexing nulls
    },
    // qrPayload: {
    //   type: Object, // Will store complete QR data
    // },
    qrCode: String,
    poLineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrderLine",
    },
    purchaseInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseInvoice",
      default: null,
    },
    // For allocated/dispatched rolls
    allocationDetails: {
      soLineId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SalesOrderLine",
      },
      allocatedAt: Date,
      allocatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    },
    // For dispatched rolls
    dispatchDetails: {
      dcId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "DeliveryChallan",
      },
      dispatchedAt: Date,
      dispatchedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    },
    // For returned/partial rolls
    returnDetails: {
      parentRollId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Roll",
      },
      returnReason: String,
      returnedAt: Date,
      inspectionNotes: String,
    },
    // Timestamps for aging
    inwardedAt: {
      type: Date,
      default: Date.now,
    },
    mappedAt: Date,
    // Location tracking
    warehouseLocation: {
      zone: String,
      rack: String,
      bin: String,
    },
    notes: String,
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
rollSchema.index({ status: 1 });
rollSchema.index({ skuId: 1, status: 1 });
rollSchema.index({ batchId: 1 });
rollSchema.index({ supplierId: 1 });
// Allow multiple null/absent barcodes; enforce uniqueness only when present
rollSchema.index(
  { barcode: 1 },
  {
    name: "barcode_sparse_unique",
    unique: true,
    partialFilterExpression: { barcode: { $exists: true, $ne: null } },
  }
);
rollSchema.index({ status: 1, inwardedAt: 1 }); // For unmapped aging
rollSchema.index({ "allocationDetails.soLineId": 1 });
rollSchema.index({ purchaseInvoiceId: 1 });

// Virtual for age in days
rollSchema.virtual("ageInDays").get(function () {
  return Math.floor((Date.now() - this.inwardedAt) / (1000 * 60 * 60 * 24));
});

// Virtual for unmapped age in days
rollSchema.virtual("unmappedAgeInDays").get(function () {
  if (this.status === "Unmapped") {
    return Math.floor((Date.now() - this.inwardedAt) / (1000 * 60 * 60 * 24));
  }
  return null;
});

// Generate barcode before saving
rollSchema.pre("save", async function (next) {
  // Auto-generate barcode only when we have supplier and batch info
  if (!this.barcode && this.isNew && this.supplierId && this.batchId) {
    const date = new Date();
    const yymm = `${date.getFullYear().toString().slice(-2)}${(
      date.getMonth() + 1
    )
      .toString()
      .padStart(2, "0")}`;

    // Get supplier code
    const supplier = await mongoose.model("Supplier").findById(this.supplierId);
    const supCode = supplier?.supplierCode?.substring(0, 3) || "SUP";

    // Get batch code
    const batch = await mongoose.model("Batch").findById(this.batchId);
    const batchCode = batch?.batchCode?.substring(0, 4) || "BCH";

    // Generate sequence
    const count = await this.constructor.countDocuments({
      batchId: this.batchId,
    });
    const seq = (count + 1).toString().padStart(4, "0");

    // Generate check digit
    const baseCode = `${yymm}-${supCode}-${batchCode}-${seq}`;
    const checkDigit =
      baseCode.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) %
      10;

    this.barcode = `${baseCode}-${checkDigit}`;

    // Generate QR code data
    this.qrCode = JSON.stringify({
      b: this.barcode,
      s: this.skuId,
      w: this.widthInches,
      l: this.currentLengthMeters,
    });
  }

  // Calculate total landed cost
  if (this.landedCostPerMeter && this.currentLengthMeters) {
    this.totalLandedCost =
      Math.round(this.landedCostPerMeter * this.currentLengthMeters * 100) /
      100;
  }

  next();
});

module.exports = mongoose.model("Roll", rollSchema);
