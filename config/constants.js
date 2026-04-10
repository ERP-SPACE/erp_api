module.exports = {
  // Document Status
  STATUS: {
    DRAFT: "Draft",
    PENDING: "Pending",
    PARTIAL: "Partial",
    COMPLETE: "Complete",
    APPROVED: "Approved",
    POSTED: "Posted",
    CANCELLED: "Cancelled",
    CLOSED: "Closed",
    OPEN: "Open",
    CONFIRMED: "Confirmed",
    ON_HOLD: "OnHold",
    PARTIALLY_RECEIVED: "PartiallyReceived",
    PARTIALLY_FULFILLED: "PartiallyFulfilled",
    PAID: "Paid",
    UNPAID: "Unpaid",
    PARTIALLY_PAID: "PartiallyPaid",
  },

  PURCHASE_ORDER_STATUS: {
    DRAFT: "Draft",
    PENDING: "Pending",
    PARTIAL: "Partial",
    COMPLETE: "Complete",
    APPROVED: "Approved",
    CANCELLED: "Cancelled",
    CLOSED: "Closed",
  },

  // Roll Status
  ROLL_STATUS: {
    UNMAPPED: "Unmapped",
    MAPPED: "Mapped",
    ALLOCATED: "Allocated",
    DISPATCHED: "Dispatched",
    RETURNED: "Returned",
    RETURNED_TO_SUPPLIER: "ReturnedToSupplier",
    SCRAP: "Scrap",
  },

  // GSM Options
  GSM_OPTIONS: [30, 35, 45, 55, 65, 80],

  // Width Options (in inches)
  WIDTH_OPTIONS: [24, 36, 44, 63],

  // Default Length Options (in meters)
  LENGTH_OPTIONS: [1000, 1500, 2000],

  // Quality Names
  QUALITY_OPTIONS: ["Premium", "Standard", "Economy", "Custom"],

  // Category Names
  CATEGORY_OPTIONS: ["Sublimation", "Butter"],

  // Customer Groups
  CUSTOMER_GROUPS: ["Cash", "Wholesale", "Big"],

  // Credit Block Rules
  BLOCK_RULES: ["OVER_LIMIT", "OVER_DUE", "BOTH"],

  // Payment Modes
  PAYMENT_MODES: ["Cash", "NEFT", "UPI", "Cheque", "RTGS"],

  // Landed Cost Types
  LANDED_COST_TYPES: ["Freight", "Duty", "Clearing", "Misc"],

  // Landed Cost Allocation Basis
  ALLOCATION_BASIS: ["ROLL", "METER", "VALUE"],

  // Ledger Groups
  LEDGER_GROUPS: ["Assets", "Liabilities", "Income", "Expenses", "Equity"],

  // Voucher Types
  VOUCHER_TYPES: [
    "Payment",
    "Receipt",
    "Contra",
    "Journal",
    "Sales",
    "Purchase",
    "DebitNote",
    "CreditNote",
  ],

  // Default Tax Rate
  DEFAULT_TAX_RATE: 18,

  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
};
