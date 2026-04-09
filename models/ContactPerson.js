const mongoose = require("mongoose");

const contactPersonSchema = new mongoose.Schema(
  {
    contactPersonId: {
      type: Number,
      unique: true,
    },
    contactPersonName: {
      type: String,
      trim: true,
    },
    contactPersonEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    contactPersonPhone: {
      type: Number,
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
contactPersonSchema.index({ contactPersonId: 1 });
contactPersonSchema.index({ customerId: 1 });
contactPersonSchema.index({ supplierId: 1 });
contactPersonSchema.index({ isPrimary: 1 });

// Auto-generate contactPersonId
contactPersonSchema.pre("save", async function (next) {
  if (!this.contactPersonId && this.isNew) {
    try {
      const lastDoc = await this.constructor
        .findOne()
        .sort({ contactPersonId: -1 })
        .select("contactPersonId");
      this.contactPersonId = lastDoc ? lastDoc.contactPersonId + 1 : 1;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Virtual to populate customer
contactPersonSchema.virtual("customer", {
  ref: "Customer",
  localField: "customerId",
  foreignField: "_id",
  justOne: true,
});

// Virtual to populate supplier
contactPersonSchema.virtual("supplier", {
  ref: "Supplier",
  localField: "supplierId",
  foreignField: "_id",
  justOne: true,
});

module.exports = mongoose.model("ContactPerson", contactPersonSchema);
