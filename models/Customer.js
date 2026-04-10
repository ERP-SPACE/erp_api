const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    customerCode: {
      type: String,
      unique: true,
      uppercase: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    gstin: {
      type: String,
      match: [
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
        "Invalid GSTIN format",
      ],
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
      billing: {
        line1: { type: String, required: true },
        line2: String,
        city: { type: String, required: true },
        pincode: { type: String, required: true },
      },
      shipping: [
        {
          label: String,
          line1: String,
          line2: String,
          city: String,
          pincode: String,
          isDefault: { type: Boolean, default: false },
        },
      ],
    },
    contactPersons: [
      {
        name: { type: String },
        designation: String,
        phone: { type: String },
        whatsapp: String,
        email: { type: String, lowercase: true },
        isPrimary: { type: Boolean, default: false },
      },
    ],
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
    },
    customerGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerGroup",
      required: [true, "Customer group is required"],
    },
    customerGroupIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CustomerGroup",
      },
    ],
    referral: {
      source: String,
      name: String,
      contact: String,
      company: String,
      remarks: String,
    },
    businessInfo: {
      monthlyCapacity: Number,
      targetSalesMeters: Number,
      businessType: String,
    },
    creditPolicy: {
      creditLimit: {
        type: Number,
        default: 0,
        min: 0,
      },
      creditDays: {
        type: Number,
        default: 0,
        min: 0,
      },
      graceDays: {
        type: Number,
        default: 0,
        min: 0,
      },
      autoBlock: {
        type: Boolean,
        default: true,
      },
      blockRule: {
        type: String,
        enum: ["OVER_LIMIT", "OVER_DUE", "BOTH"],
        default: "BOTH",
      },
      currentExposure: {
        type: Number,
        default: 0,
      },
      isBlocked: {
        type: Boolean,
        default: false,
      },
      blockReason: String,
      blockedAt: Date,
      unblockedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    },
    whatsappConfig: {
      enabled: {
        type: Boolean,
        default: true,
      },
      language: {
        type: String,
        enum: ["English", "Hindi", "Gujarati"],
        default: "English",
      },
      optedIn: {
        type: Boolean,
        default: false,
      },
      optedInAt: Date,
      notifications: {
        orderConfirmation: { type: Boolean, default: true },
        dispatch: { type: Boolean, default: true },
        invoice: { type: Boolean, default: true },
        payment: { type: Boolean, default: true },
        statement: { type: Boolean, default: true },
        dunning: { type: Boolean, default: true },
      },
    },
    notes: String,
    active: {
      type: Boolean,
      default: true,
    },
    onboardedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    onboardedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
customerSchema.index({ customerCode: 1 });
customerSchema.index({ gstin: 1 });
customerSchema.index({ customerGroupId: 1 });
customerSchema.index({ agentId: 1 });
customerSchema.index({ customerGroupIds: 1 });
customerSchema.index({ active: 1 });
customerSchema.index({ "creditPolicy.isBlocked": 1 });
customerSchema.index({ companyName: "text" });

// Generate customer code
customerSchema.pre("save", async function (next) {
  if (!this.customerCode && this.isNew) {
    try {
      const prefix = "CUS";
      const lastCustomer = await this.constructor
        .findOne({
          customerCode: { $regex: `^${prefix}\\d+$`, $options: "i" },
        })
        .sort({ customerCode: -1 })
        .select("customerCode");

      const lastSequence = lastCustomer?.customerCode
        ? parseInt(lastCustomer.customerCode.replace(prefix, ""), 10)
        : 0;

      this.customerCode = `${prefix}${String(lastSequence + 1).padStart(5, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Virtual to populate customerGroup via customerGroupId
customerSchema.virtual("customerGroup", {
  ref: "CustomerGroup",
  localField: "customerGroupId",
  foreignField: "_id",
  justOne: true,
});

// Virtual for outstanding amount
customerSchema.virtual("outstandingAmount").get(function () {
  // This would be calculated from sales invoices and payments
  return this.creditPolicy.currentExposure;
});

module.exports = mongoose.model("Customer", customerSchema);
