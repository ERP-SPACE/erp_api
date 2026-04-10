const supplierService = require("../services/supplierService");
const catchAsync = require("../utils/catchAsync");

class SupplierController {
  getNextSupplierCode = catchAsync(async (req, res) => {
    const code = await supplierService.getNextSupplierCode();

    res.status(200).json({
      success: true,
      data: { supplierCode: code },
    });
  });

  createSupplier = catchAsync(async (req, res) => {
    const supplier = await supplierService.createSupplier(req.body);

    res.status(201).json({
      success: true,
      message: "Supplier created successfully",
      data: supplier,
    });
  });

  getAllSuppliers = catchAsync(async (req, res) => {
    const filters = {
      active:
        req.query.active === "true"
          ? true
          : req.query.active === "false"
          ? false
          : undefined,
      search: req.query.search,
    };

    const pagination = {
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await supplierService.getAllSuppliers(filters, pagination);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  getSupplierById = catchAsync(async (req, res) => {
    const supplier = await supplierService.getSupplierById(req.params.id);

    res.status(200).json({
      success: true,
      data: supplier,
    });
  });

  getSupplierByCode = catchAsync(async (req, res) => {
    const supplier = await supplierService.getSupplierByCode(req.params.code);

    res.status(200).json({
      success: true,
      data: supplier,
    });
  });

  updateSupplier = catchAsync(async (req, res) => {
    const supplier = await supplierService.updateSupplier(
      req.params.id,
      req.body
    );

    res.status(200).json({
      success: true,
      message: "Supplier updated successfully",
      data: supplier,
    });
  });

  toggleSupplierStatus = catchAsync(async (req, res) => {
    const supplier = await supplierService.toggleSupplierStatus(req.params.id);

    res.status(200).json({
      success: true,
      message: `Supplier ${
        supplier.active ? "activated" : "deactivated"
      } successfully`,
      data: supplier,
    });
  });

  deleteSupplier = catchAsync(async (req, res) => {
    await supplierService.deleteSupplier(req.params.id);

    res.status(200).json({
      success: true,
      message: "Supplier deleted successfully",
    });
  });

  // =====================
  // Base Rate Methods
  // =====================

  getSupplierBaseRates = catchAsync(async (req, res) => {
    const baseRates = await supplierService.getSupplierBaseRates(req.params.id);

    res.status(200).json({
      success: true,
      count: baseRates.length,
      data: baseRates,
    });
  });

  upsertSupplierBaseRate = catchAsync(async (req, res) => {
    const productId = req.body.productId || req.body.productid;
    const rate =
      req.body.rate !== undefined && req.body.rate !== null
        ? req.body.rate
        : req.body.baseRate;

    const baseRate = await supplierService.upsertSupplierBaseRate(
      req.params.id,
      productId,
      rate
    );

    res.status(200).json({
      success: true,
      message: "Base rate saved successfully",
      data: baseRate,
    });
  });

  deleteSupplierBaseRate = catchAsync(async (req, res) => {
    await supplierService.deleteSupplierBaseRate(
      req.params.id,
      req.params.baseRateId
    );

    res.status(200).json({
      success: true,
      message: "Base rate deleted successfully",
    });
  });

  getSupplierBaseRateHistory = catchAsync(async (req, res) => {
    const history = await supplierService.getSupplierBaseRateHistory(
      req.params.id,
      req.params.baseRateId
    );

    res.status(200).json({
      success: true,
      count: history.length,
      data: history,
    });
  });

  getAllSupplierRateHistory = catchAsync(async (req, res) => {
    const history = await supplierService.getAllSupplierRateHistory(
      req.params.id
    );

    res.status(200).json({
      success: true,
      count: history.length,
      data: history,
    });
  });

  bulkUpsertSupplierBaseRates = catchAsync(async (req, res) => {
    const rates = Array.isArray(req.body.rates)
      ? req.body.rates.map((entry = {}) => ({
          ...entry,
          productId: entry.productId || entry.productid,
          rate:
            entry.rate !== undefined && entry.rate !== null
              ? entry.rate
              : entry.baseRate,
        }))
      : req.body.rates;

    const result = await supplierService.bulkUpsertSupplierBaseRates(
      req.params.id,
      rates
    );

    res.status(200).json({
      success: true,
      message: "Bulk base rates processed",
      data: result,
    });
  });

  // =====================
  // Contact Person Methods
  // =====================

  getSupplierContactPersons = catchAsync(async (req, res) => {
    const contactPersons = await supplierService.getSupplierContactPersons(
      req.params.id
    );

    res.status(200).json({
      success: true,
      count: contactPersons.length,
      data: contactPersons,
    });
  });

  createSupplierContactPerson = catchAsync(async (req, res) => {
    const contactPerson = await supplierService.createSupplierContactPerson(
      req.params.id,
      req.body
    );

    res.status(201).json({
      success: true,
      message: "Contact person created successfully",
      data: contactPerson,
    });
  });

  updateSupplierContactPerson = catchAsync(async (req, res) => {
    const contactPerson = await supplierService.updateSupplierContactPerson(
      req.params.id,
      req.params.contactPersonId,
      req.body
    );

    res.status(200).json({
      success: true,
      message: "Contact person updated successfully",
      data: contactPerson,
    });
  });

  deleteSupplierContactPerson = catchAsync(async (req, res) => {
    await supplierService.deleteSupplierContactPerson(
      req.params.id,
      req.params.contactPersonId
    );

    res.status(200).json({
      success: true,
      message: "Contact person deleted successfully",
    });
  });

  setSupplierContactPersonPrimary = catchAsync(async (req, res) => {
    const contactPerson = await supplierService.setSupplierContactPersonPrimary(
      req.params.id,
      req.params.contactPersonId
    );

    res.status(200).json({
      success: true,
      message: "Contact person set as primary",
      data: contactPerson,
    });
  });
}

module.exports = new SupplierController();
