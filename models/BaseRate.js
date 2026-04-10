const mongoose = require("mongoose");

const baseRateSchema = new mongoose.Schema(
  {
    baseRateId: {
      type: Number,
      unique: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "Product is required"],
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
    rate: {
      type: Number,
      required: [true, "Rate is required"],
      min: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
baseRateSchema.index({ baseRateId: 1 });
baseRateSchema.index({ productId: 1 });
baseRateSchema.index({ supplierId: 1 });
baseRateSchema.index({ agentId: 1 });
baseRateSchema.index({ customerId: 1 });

// Unique compound indexes: One rate per Product per entity
// Ensures a supplier can only have one rate per Product
baseRateSchema.index(
  { productId: 1, supplierId: 1 },
  {
    unique: true,
    partialFilterExpression: { supplierId: { $ne: null } },
  }
);

// Ensures an agent can only have one rate per Product
baseRateSchema.index(
  { productId: 1, agentId: 1 },
  {
    unique: true,
    partialFilterExpression: { agentId: { $ne: null } },
  }
);

// Ensures a customer can only have one rate per Product
baseRateSchema.index(
  { productId: 1, customerId: 1 },
  {
    unique: true,
    partialFilterExpression: { customerId: { $ne: null } },
  }
);

// Validation: Exactly one of supplierId, agentId, or customerId must have a value
baseRateSchema.pre("validate", function (next) {
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

// Auto-generate baseRateId
baseRateSchema.pre("save", async function (next) {
  if (!this.baseRateId && this.isNew) {
    try {
      const lastDoc = await this.constructor
        .findOne()
        .sort({ baseRateId: -1 })
        .select("baseRateId");
      this.baseRateId = lastDoc ? lastDoc.baseRateId + 1 : 1;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Virtual to populate Product
baseRateSchema.virtual("product", {
  ref: "Product",
  localField: "productId",
  foreignField: "_id",
  justOne: true,
});

// Virtual to populate supplier
baseRateSchema.virtual("supplier", {
  ref: "Supplier",
  localField: "supplierId",
  foreignField: "_id",
  justOne: true,
});

// Virtual to populate agent
baseRateSchema.virtual("agent", {
  ref: "Agent",
  localField: "agentId",
  foreignField: "_id",
  justOne: true,
});

// Virtual to populate customer
baseRateSchema.virtual("customer", {
  ref: "Customer",
  localField: "customerId",
  foreignField: "_id",
  justOne: true,
});

module.exports = mongoose.model("BaseRate", baseRateSchema);
