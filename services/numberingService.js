const moment = require("moment");

class NumberingService {
  /**
   * Generate a sequential number in the format: PREFIX-YYMM-####.
   * Allows overriding the field name to match models that don't follow
   * the `${prefix.toLowerCase()}Number` convention (e.g., voucherNumber).
   */
  async generateNumber(prefix, model, fieldName) {
    const yearMonth = moment().format("YYMM");
    const pattern = `${prefix}-${yearMonth}`;

    const numberField = fieldName || `${prefix.toLowerCase()}Number`;

    // Find the last document with this pattern
    const lastDoc = await model
      .findOne({
        [numberField]: new RegExp(`^${pattern}`),
      })
      .sort({ [numberField]: -1 });

    let sequence = 1;
    if (lastDoc?.[numberField]) {
      const lastNumber = lastDoc[numberField];
      const lastSequence = parseInt(lastNumber.split("-").pop(), 10);
      if (!Number.isNaN(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }

    return `${pattern}-${String(sequence).padStart(4, "0")}`;
  }

  /**
   * Generate a sequential number in the format: PREFIX/YY-YY/##### (financial year).
   * FY is computed based on the provided date (defaults to today), with FY starting April 1st.
   */
  async generateFiscalYearNumber(prefix, model, fieldName, date = new Date()) {
    const d = moment(date);
    const fiscalStartYear = d.month() >= 3 ? d.year() : d.year() - 1; // month is 0-based
    const fy = `${String(fiscalStartYear).slice(-2)}-${String(fiscalStartYear + 1).slice(-2)}`;
    const pattern = `${prefix}/${fy}/`;

    const numberField = fieldName || `${prefix.toLowerCase()}Number`;

    const lastDoc = await model
      .findOne({
        [numberField]: new RegExp(`^${pattern.replace("/", "\\/")}`),
      })
      .sort({ [numberField]: -1 });

    let sequence = 1;
    if (lastDoc?.[numberField]) {
      const lastNumber = lastDoc[numberField];
      const lastSequence = parseInt(String(lastNumber).split("/").pop(), 10);
      if (!Number.isNaN(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }

    return `${pattern}${String(sequence).padStart(5, "0")}`;
  }

  generateSupplierCode(sequence) {
    return `SUP-${String(sequence).padStart(4, "0")}`;
  }

  generateCustomerCode(sequence) {
    return `CUST-${String(sequence).padStart(4, "0")}`;
  }

  generateBatchCode() {
    const yearMonth = moment().format("YYMM");
    const random = Math.floor(Math.random() * 1000);
    return `BATCH-${yearMonth}-${String(random).padStart(3, "0")}`;
  }

  generateRollNumber(supplierCode, batchCode, sequence) {
    const yearMonth = moment().format("YYMM");
    const supCode = supplierCode.split("-")[1];
    const batchNum = batchCode.split("-").pop();
    return `${yearMonth}-${supCode}-${batchNum}-${String(sequence).padStart(
      4,
      "0"
    )}`;
  }
}

module.exports = new NumberingService();
