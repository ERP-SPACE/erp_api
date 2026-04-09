const Supplier = require("../models/Supplier");
const BaseRate = require("../models/BaseRate");
const RateHistory = require("../models/RateHistory");
const ContactPerson = require("../models/ContactPerson");
const AppError = require("../utils/AppError");

const mapBaseRateForUi = (baseRateDoc) => {
  if (!baseRateDoc) {
    return baseRateDoc;
  }

  const rate =
    typeof baseRateDoc.toObject === "function"
      ? baseRateDoc.toObject({ virtuals: true })
      : { ...baseRateDoc };

  return {
    ...rate,
    supplierid: rate.supplierId,
    agentid: rate.agentId,
    customerid: rate.customerId,
    skuid: rate.skuId,
  };
};

class SupplierService {
  async getNextSupplierCode() {
    const count = await Supplier.countDocuments();
    return `SUP${(count + 1).toString().padStart(5, "0")}`;
  }

  async createSupplier(data) {
    // Check for duplicate GSTIN
    const existingSupplier = await Supplier.findOne({ gstin: data.gstin });
    if (existingSupplier) {
      throw new AppError("Supplier with this GSTIN already exists", 400);
    }

    const supplier = await Supplier.create(data);
    return supplier;
  }

  async getAllSuppliers(filters = {}, pagination = {}) {
    const query = {};

    if (filters.active !== undefined) {
      query.active = filters.active;
    }

    if (filters.search) {
      query.$or = [
        { name: { $regex: filters.search, $options: "i" } },
        { supplierCode: { $regex: filters.search, $options: "i" } },
        { gstin: { $regex: filters.search, $options: "i" } },
      ];
    }

    const hasLimit = pagination.limit !== undefined && pagination.limit !== null;
    const page = hasLimit ? parseInt(pagination.page) || 1 : 1;
    const limit = hasLimit ? parseInt(pagination.limit) || 10 : null;
    const skip = hasLimit && limit ? (page - 1) * limit : 0;

    const supplierQuery = Supplier.find(query).sort({ name: 1 });

    if (hasLimit && limit) {
      supplierQuery.skip(skip).limit(limit);
    }

    const [suppliers, total] = await Promise.all([
      supplierQuery.exec(),
      Supplier.countDocuments(query),
    ]);

    return {
      suppliers,
      pagination: hasLimit
        ? {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          }
        : {
            page: 1,
            limit: total,
            total,
            pages: 1,
          },
    };
  }

  async getSupplierById(id) {
    const supplier = await Supplier.findById(id);

    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    return supplier;
  }

  async getSupplierByCode(code) {
    const supplier = await Supplier.findOne({
      supplierCode: code.toUpperCase(),
    });

    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    return supplier;
  }

  async updateSupplier(id, updateData) {
    // Don't allow changing GSTIN or supplierCode
    delete updateData.gstin;
    delete updateData.supplierCode;

    const supplier = await Supplier.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    return supplier;
  }

  async toggleSupplierStatus(id) {
    const supplier = await Supplier.findById(id);

    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    supplier.active = !supplier.active;
    await supplier.save();

    return supplier;
  }

  async deleteSupplier(id) {
    // Check if supplier has purchase orders
    const PurchaseOrder = require("../models/PurchaseOrder");
    const poCount = await PurchaseOrder.countDocuments({ supplierId: id });

    if (poCount > 0) {
      throw new AppError(
        "Cannot delete supplier with existing purchase orders",
        400
      );
    }

    // Also delete associated base rates
    await BaseRate.deleteMany({ supplierId: id });

    const supplier = await Supplier.findByIdAndDelete(id);

    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    return { message: "Supplier deleted successfully" };
  }

  // =====================
  // Base Rate Methods
  // =====================

  /**
   * Get all base rates for a supplier
   */
  async getSupplierBaseRates(supplierId) {
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    const baseRates = await BaseRate.find({ supplierId })
      .populate({
        path: "skuId",
        select: "skuCode skuAlias widthInches productId",
        populate: {
          path: "productId",
          select: "productCode productAlias categoryId gsmId qualityId",
          populate: [
            { path: "categoryId", select: "name" },
            { path: "gsmId", select: "name" },
            { path: "qualityId", select: "name" },
          ],
        },
      })
      .sort({ createdAt: -1 });

    return baseRates.map(mapBaseRateForUi);
  }

  /**
   * Create or update a base rate for a supplier-SKU combination
   */
  async upsertSupplierBaseRate(supplierId, skuId, rate) {
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    const SKU = require("../models/SKU");
    const sku = await SKU.findById(skuId);
    if (!sku) {
      throw new AppError("SKU not found", 404);
    }

    // Check if a base rate already exists for this supplier-SKU combination
    let baseRate = await BaseRate.findOne({ supplierId, skuId });

    if (baseRate) {
      // Create history record before updating
      await RateHistory.create({
        baseRateId: baseRate._id,
        skuId: baseRate.skuId,
        supplierId: baseRate.supplierId,
        agentId: baseRate.agentId,
        customerId: baseRate.customerId,
        previousRate: baseRate.rate,
      });

      // Update existing rate
      baseRate.rate = rate;
      await baseRate.save();
    } else {
      // Create new base rate
      baseRate = await BaseRate.create({
        supplierId,
        skuId,
        rate,
      });
    }

    // Re-fetch with populated data
    const populatedRate = await BaseRate.findById(baseRate._id).populate({
      path: "skuId",
      select: "skuCode skuAlias widthInches productId",
      populate: {
        path: "productId",
        select: "productCode productAlias categoryId gsmId qualityId",
        populate: [
          { path: "categoryId", select: "name" },
          { path: "gsmId", select: "name" },
          { path: "qualityId", select: "name" },
        ],
      },
    });

    return mapBaseRateForUi(populatedRate);
  }

  /**
   * Delete a base rate
   */
  async deleteSupplierBaseRate(supplierId, baseRateId) {
    const baseRate = await BaseRate.findOne({ _id: baseRateId, supplierId });

    if (!baseRate) {
      throw new AppError("Base rate not found for this supplier", 404);
    }

    // Delete associated rate history
    await RateHistory.deleteMany({ baseRateId });

    await BaseRate.findByIdAndDelete(baseRateId);

    return { message: "Base rate deleted successfully" };
  }

  /**
   * Get rate history for a specific base rate
   */
  async getSupplierBaseRateHistory(supplierId, baseRateId) {
    const baseRate = await BaseRate.findOne({ _id: baseRateId, supplierId });

    if (!baseRate) {
      throw new AppError("Base rate not found for this supplier", 404);
    }

    const history = await RateHistory.find({ supplierId, baseRateId })
      .populate({
        path: "skuId",
        select: "skuCode skuAlias widthInches productId",
        populate: {
          path: "productId",
          select: "productCode productAlias categoryId gsmId qualityId",
          populate: [
            { path: "categoryId", select: "name" },
            { path: "gsmId", select: "name" },
            { path: "qualityId", select: "name" },
          ],
        },
      })
      .sort({ createdAt: -1 });

    return history.map(mapBaseRateForUi);
  }

  /**
   * Get all rate history for a supplier
   */
  async getAllSupplierRateHistory(supplierId) {
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    const history = await RateHistory.find({ supplierId })
      .populate({
        path: "skuId",
        select: "skuCode skuAlias widthInches productId",
        populate: {
          path: "productId",
          select: "productCode productAlias categoryId gsmId qualityId",
          populate: [
            { path: "categoryId", select: "name" },
            { path: "gsmId", select: "name" },
            { path: "qualityId", select: "name" },
          ],
        },
      })
      .sort({ createdAt: -1 });

    return history.map(mapBaseRateForUi);
  }

  /**
   * Bulk create/update base rates for a supplier
   */
  async bulkUpsertSupplierBaseRates(supplierId, rates) {
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    const results = {
      success: [],
      failed: [],
    };

    for (const { skuId, rate } of rates) {
      try {
        const baseRate = await this.upsertSupplierBaseRate(supplierId, skuId, rate);
        results.success.push(baseRate);
      } catch (error) {
        results.failed.push({
          skuId,
          rate,
          error: error.message,
        });
      }
    }

    return results;
  }

  // =====================
  // Contact Person Methods
  // =====================

  /**
   * Get all contact persons for a supplier
   */
  async getSupplierContactPersons(supplierId) {
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    const contactPersons = await ContactPerson.find({ supplierId })
      .sort({ isPrimary: -1, contactPersonName: 1 });

    return contactPersons;
  }

  /**
   * Create a contact person for a supplier
   */
  async createSupplierContactPerson(supplierId, data) {
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new AppError("Supplier not found", 404);
    }

    // If this is marked as primary, unset primary on all other contacts
    if (data.isPrimary) {
      await ContactPerson.updateMany(
        { supplierId, isPrimary: true },
        { isPrimary: false }
      );
    }

    // If this is the first contact person, make it primary by default
    const existingCount = await ContactPerson.countDocuments({ supplierId });
    if (existingCount === 0) {
      data.isPrimary = true;
    }

    const contactPerson = await ContactPerson.create({
      ...data,
      supplierId,
      customerId: null, // Ensure this is a supplier contact
    });

    return contactPerson;
  }

  /**
   * Update a contact person
   */
  async updateSupplierContactPerson(supplierId, contactPersonId, data) {
    const contactPerson = await ContactPerson.findOne({
      _id: contactPersonId,
      supplierId,
    });

    if (!contactPerson) {
      throw new AppError("Contact person not found for this supplier", 404);
    }

    // If setting this as primary, unset primary on all other contacts
    if (data.isPrimary && !contactPerson.isPrimary) {
      await ContactPerson.updateMany(
        { supplierId, isPrimary: true, _id: { $ne: contactPersonId } },
        { isPrimary: false }
      );
    }

    // Update the contact person
    Object.assign(contactPerson, data);
    await contactPerson.save();

    return contactPerson;
  }

  /**
   * Delete a contact person
   */
  async deleteSupplierContactPerson(supplierId, contactPersonId) {
    const contactPerson = await ContactPerson.findOne({
      _id: contactPersonId,
      supplierId,
    });

    if (!contactPerson) {
      throw new AppError("Contact person not found for this supplier", 404);
    }

    const wasPrimary = contactPerson.isPrimary;
    await ContactPerson.findByIdAndDelete(contactPersonId);

    // If the deleted contact was primary, make another one primary
    if (wasPrimary) {
      const nextContact = await ContactPerson.findOne({ supplierId });
      if (nextContact) {
        nextContact.isPrimary = true;
        await nextContact.save();
      }
    }

    return { message: "Contact person deleted successfully" };
  }

  /**
   * Set a contact person as primary
   */
  async setSupplierContactPersonPrimary(supplierId, contactPersonId) {
    const contactPerson = await ContactPerson.findOne({
      _id: contactPersonId,
      supplierId,
    });

    if (!contactPerson) {
      throw new AppError("Contact person not found for this supplier", 404);
    }

    // Unset primary on all other contacts
    await ContactPerson.updateMany(
      { supplierId, isPrimary: true, _id: { $ne: contactPersonId } },
      { isPrimary: false }
    );

    // Set this contact as primary
    contactPerson.isPrimary = true;
    await contactPerson.save();

    return contactPerson;
  }
}

module.exports = new SupplierService();
