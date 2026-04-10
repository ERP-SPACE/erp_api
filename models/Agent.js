// models/Agent.js
const mongoose = require("mongoose");

const DOCUMENT_TYPES = ["aadhaar", "passport", "license", "pan", "other"];
const COMMISSION_METHODS = ["per_meter", "percentage"];

const kycDocumentSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    documentType: {
      type: String,
      enum: DOCUMENT_TYPES,
      default: "other",
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    fileUrl: {
      type: String,
      required: true,
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    notes: String,
  },
  { _id: false }
);

const partyCommissionHistorySchema = new mongoose.Schema(
  {
    historyId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    commissionType: {
      type: String,
      enum: COMMISSION_METHODS,
      required: true,
    },
    amountPerMeter: {
      type: Number,
      min: 0,
    },
    percentage: {
      type: Number,
      min: 0,
      max: 100,
    },
    effectiveFrom: {
      type: Date,
      required: true,
      default: Date.now,
    },
    effectiveTo: Date,
    notes: String,
  },
  {
    _id: false,
    timestamps: true,
  }
);

partyCommissionHistorySchema.pre("validate", function (next) {
  if (this.commissionType === "per_meter") {
    if (this.amountPerMeter == null) {
      return next(new Error("amountPerMeter is required for per_meter commissions"));
    }
    this.percentage = undefined;
  } else if (this.commissionType === "percentage") {
    if (this.percentage == null) {
      return next(new Error("percentage is required for percentage commissions"));
    }
    this.amountPerMeter = undefined;
  }
  next();
});

const partyCommissionSchema = new mongoose.Schema(
  {
    entryId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    commissionType: {
      type: String,
      enum: COMMISSION_METHODS,
      required: true,
    },
    amountPerMeter: {
      type: Number,
      min: 0,
    },
    percentage: {
      type: Number,
      min: 0,
      max: 100,
    },
    applyByDefault: {
      type: Boolean,
      default: true,
    },
    history: [partyCommissionHistorySchema],
  },
  {
    _id: false,
    timestamps: true,
  }
);

partyCommissionSchema.pre("validate", function (next) {
  if (this.commissionType === "per_meter") {
    if (this.amountPerMeter == null) {
      return next(new Error("amountPerMeter is required for per_meter commissions"));
    }
    this.percentage = undefined;
  } else if (this.commissionType === "percentage") {
    if (this.percentage == null) {
      return next(new Error("percentage is required for percentage commissions"));
    }
    this.amountPerMeter = undefined;
  }
  next();
});

const commissionPayoutSchema = new mongoose.Schema(
  {
    payoutId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    reference: String,
    periodStart: Date,
    periodEnd: Date,
    amount: {
      type: Number,
      min: 0,
      required: true,
    },
    payoutStatus: {
      type: String,
      enum: ["pending", "paid", "on_hold"],
      default: "pending",
    },
    paidOn: Date,
    paymentReference: String,
    notes: String,
  },
  {
    _id: false,
    timestamps: true,
  }
);

const commissionChangeSchema = new mongoose.Schema(
  {
    changeId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    previousCommissionType: {
      type: String,
      enum: COMMISSION_METHODS,
    },
    newCommissionType: {
      type: String,
      enum: COMMISSION_METHODS,
    },
    previousAmountPerMeter: {
      type: Number,
      min: 0,
    },
    newAmountPerMeter: {
      type: Number,
      min: 0,
    },
    previousPercentage: {
      type: Number,
      min: 0,
      max: 100,
    },
    newPercentage: {
      type: Number,
      min: 0,
      max: 100,
    },
    changeDate: {
      type: Date,
      default: Date.now,
    },
    notes: String,
  },
  {
    _id: false,
    timestamps: true,
  }
);

const defaultSkuRateSchema = new mongoose.Schema(
  {
    // 44" benchmark is per Product (aligned with BaseRate.productId)
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    /** @deprecated Legacy field — prefer `product`; may still exist on old documents */
    sku: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SKU",
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: String,
  },
  {
    _id: false,
    timestamps: true,
  }
);

const agentSchema = new mongoose.Schema(
  {
    agentCode: {
      type: String,
      unique: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: [true, "Agent name is required"],
      trim: true,
    },

    pan: {
      type: String,
      match: [/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN format"],
    },
    state: {
      type: String,
      required: true,
    },
    address: {
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      pincode: { type: String, required: true },
    },
    phone: {
      type: String,
      required: true,
    },
    whatsapp: String,
    email: { type: String, lowercase: true },

    customers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
      },
    ],
    commissionRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    defaultRate: {
      type: Number,
      min: 0,
    },
    defaultCreditLimit: {
      type: Number,
      min: 0,
    },
    defaultCreditDays: {
      type: Number,
      min: 0,
    },
    defaultGraceDays: {
      type: Number,
      min: 0,
    },
    notes: String,
    active: {
      type: Boolean,
      default: true,
    },
    targetSalesMeters: {
      type: Number,
      min: 0,
      default: 0,
    },
    kycDocuments: [kycDocumentSchema],
    blockNewSalesForAllParties: {
      type: Boolean,
      default: false,
    },
    blockNewDeliveriesForAllParties: {
      type: Boolean,
      default: false,
    },
    blockedSalesCustomers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
      },
    ],
    blockedDeliveryCustomers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
      },
    ],
    partyCommissions: [partyCommissionSchema],
    commissionChanges: [commissionChangeSchema],
    commissionPayouts: [commissionPayoutSchema],
    defaultSkuRates: [defaultSkuRateSchema],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
agentSchema.index({ agentCode: 1 });
agentSchema.index({ gstin: 1 });
agentSchema.index({ customers: 1 });
agentSchema.index({ active: 1 });
agentSchema.index({ name: "text", companyName: "text" });
agentSchema.index({ "partyCommissions.customer": 1 });
agentSchema.index({ "commissionPayouts.payoutStatus": 1 });
agentSchema.index({ blockNewSalesForAllParties: 1 });
agentSchema.index({ "defaultSkuRates.product": 1 });

// Generate agent code
agentSchema.pre("save", async function (next) {
  if (!this.agentCode && this.isNew) {
    try {
      const count = await this.constructor.countDocuments();
      this.agentCode = `AGT${(count + 1).toString().padStart(5, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Virtual to populate customers
agentSchema.virtual("customerList", {
  ref: "Customer",
  localField: "customers",
  foreignField: "_id",
  justOne: false,
});

module.exports = mongoose.model("Agent", agentSchema);
