const mongoose = require("mongoose");
const { STATUS } = require("../config/constants");

const deliveryChallanLineSchema = new mongoose.Schema({
  soLineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SalesOrder.lines",
  },
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
  widthInches: Number,
  shippedLengthMeters: Number,
  shippedStatus: {
    type: String,
    enum: ["Packed", "Dispatched"],
    default: "Packed",
  },
});

const deliveryChallanSchema = new mongoose.Schema(
  {
    dcNumber: {
      type: String,
      unique: true,
      required: true,
    },
    salesOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesOrder",
      required: true,
    },
    soNumber: {
      type: String,
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
    dcDate: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: [STATUS.DRAFT, STATUS.POSTED, STATUS.CLOSED],
      default: STATUS.DRAFT,
    },
    lines: [deliveryChallanLineSchema],
    vehicleNumber: String,
    driverName: String,
    driverPhone: String,
    notes: String,
    invoicedInSIId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesInvoice",
    },
    invoicedAt: Date,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
deliveryChallanSchema.index({ dcNumber: 1 });
deliveryChallanSchema.index({ salesOrderId: 1 });
deliveryChallanSchema.index({ customerId: 1 });
deliveryChallanSchema.index({ status: 1 });

module.exports = mongoose.model("DeliveryChallan", deliveryChallanSchema);
