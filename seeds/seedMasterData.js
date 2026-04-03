const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Category = require("../models/Category");
const GSM = require("../models/GSM");
const Quality = require("../models/Quality");
const Product = require("../models/Product");
const SKU = require("../models/SKU");
const Supplier = require("../models/Supplier");
const User = require("../models/User");
const CustomerGroup = require("../models/CustomerGroup");
const Customer = require("../models/Customer");
const CustomerRate = require("../models/CustomerRate");
const Ledger = require("../models/Ledger");
const Agent = require("../models/Agent");

dotenv.config();

const seedData = async () => {
  try {
    // Connect to MongoDB
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not set");
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB");

    // Drop problematic compound index if it exists
    try {
      const db = mongoose.connection.db;
      const collection = db.collection("skus");
      const indexes = await collection.indexes();

      const compoundIndexName = "productId_1_widthInches_1";
      const indexExists = indexes.some((idx) => idx.name === compoundIndexName);

      if (indexExists) {
        await collection.dropIndex(compoundIndexName);
        console.log("Dropped problematic compound index");
      }
    } catch (error) {
      console.log(
        "No problematic index found or error dropping:",
        error.message
      );
    }

    // Clear existing data (with error handling for existing data)
    try {
      await Category.deleteMany({});
      await GSM.deleteMany({});
      await Quality.deleteMany({});
      await Product.deleteMany({});
      await SKU.deleteMany({});
      await Supplier.deleteMany({});
      await CustomerRate.deleteMany({});
      await Customer.deleteMany({});
      await CustomerGroup.deleteMany({});
      await Agent.deleteMany({});
      await Ledger.deleteMany({});
      console.log("Existing data cleared");
    } catch (error) {
      console.log("Error clearing data (may not exist yet):", error.message);
    }

    // Ensure there is at least one SuperAdmin user
    try {
      const existingAdmin = await User.findOne({ username: "admin" });
      if (existingAdmin) {
        console.log("Default admin user already exists:", existingAdmin.email);
      } else {
        const shouldCreateSeedAdmin =
          (process.env.CREATE_SEED_ADMIN || "").toLowerCase() === "true";
        if (!shouldCreateSeedAdmin) {
          console.log(
            "Skipping seed admin creation (set CREATE_SEED_ADMIN=true to enable)"
          );
        } else if (!process.env.SEED_ADMIN_PASSWORD) {
          throw new Error("SEED_ADMIN_PASSWORD is required when seeding admin");
        }

        const adminUser = new User({
          username: "admin",
          email: "admin@gmail.com",
          password: process.env.SEED_ADMIN_PASSWORD,
          role: "SuperAdmin",
          address: {
            line1: "123 Main St",
            line2: "Apt 1",
            city: "Surat",
            pincode: "395002",
          },
          state: "Gujarat",
          country: "India",
        });
        await adminUser.save();
        console.log(
          "Default admin user created: admin / ****(from env)****"
        );
      }
    } catch (error) {
      console.error("Error ensuring default admin user:", error.message);
    }

    // Seed Categories (align with Category model: name + code + hsnCode)
    const categories = await Category.insertMany([
      { name: "Sublimation", code: "SUB", hsnCode: "4809", active: true },
      { name: "Butter", code: "BTR", hsnCode: "4806", active: true },
    ]);
    console.log("Categories seeded");

    // Seed GSM records
    const gsmRecords = await GSM.insertMany([
      { name: "30 GSM", value: 30, active: true },
      { name: "35 GSM", value: 35, active: true },
      { name: "45 GSM", value: 45, active: true },
      { name: "55 GSM", value: 55, active: true },
      { name: "65 GSM", value: 65, active: true },
      { name: "80 GSM", value: 80, active: true },
    ]);
    console.log("GSM records seeded");

    // Create GSM map for easy lookup
    const gsmMap = new Map(gsmRecords.map((g) => [g.name, g._id]));

    // Seed Quality records
    const qualityRecords = await Quality.insertMany([
      { name: "Premium", active: true },
      { name: "Standard", active: true },
      { name: "Economy", active: true },
    ]);
    console.log("Quality records seeded");

    // Create Quality map for easy lookup
    const qualityMap = new Map(qualityRecords.map((q) => [q.name, q._id]));

    // Seed Products (align with Product model)
    const products = [];
    for (const category of categories) {
      for (const gsmName of [
        "30 GSM",
        "35 GSM",
        "45 GSM",
        "55 GSM",
        "65 GSM",
        "80 GSM",
      ]) {
        for (const qualityName of ["Premium", "Standard", "Economy"]) {
          const gsmId = gsmMap.get(gsmName);
          const qualityId = qualityMap.get(qualityName);

          if (!gsmId || !qualityId) {
            console.error(
              `Missing GSM or Quality for ${gsmName} / ${qualityName}`
            );
            continue;
          }

          // Generate productAlias: gsm.name + category.name (e.g., "30 GSM Sublimation")
          const productAlias = `${gsmName} ${category.name}`;

          // Generate productCode: gsm.name + quality.name + category.name (e.g., "30 GSMPremiumSublimation")
          const productCode = `${gsmName} ${qualityName} ${category.name}`;

          products.push({
            categoryId: category._id,
            gsmId: gsmId,
            qualityId: qualityId,
            hsnCode: category.hsnCode,
            taxRate: 18,
            defaultLengthMeters: 1000, // Required field: enum [1000, 1500, 2000]
            productAlias: productAlias,
            productCode: productCode,
            active: true,
          });
        }
      }
    }

    const insertedProducts = await Product.insertMany(products);
    console.log("Products seeded");

    // Seed SKUs
    // Populate products with GSM, Quality, and Category for SKU code generation
    const populatedProducts = await Product.find({
      _id: { $in: insertedProducts.map((p) => p._id) },
    })
      .populate("gsmId")
      .populate("qualityId")
      .populate("categoryId");

    const skus = [];
    for (const product of populatedProducts) {
      const widths = [24, 36, 44, 63];
      for (const width of widths) {
        skus.push({
          productId: product._id,
          widthInches: width,
          taxRate: 18,
          skuCode: `${width}-${product.productCode}`,
          skuAlias: `${width}-${product.productAlias}`,
          active: true,
        });
      }
    }

    // Insert SKUs with duplicate handling
    try {
      const result = await SKU.insertMany(skus, { ordered: false });
      console.log(`${result.length} SKUs seeded`);
    } catch (error) {
      if (error.code === 11000) {
        console.log("Some SKUs already exist, skipping duplicates...");
        // Get existing SKU codes
        const existingSkuCodes = await SKU.distinct("skuCode");
        const newSkus = skus.filter(
          (sku) => !existingSkuCodes.includes(sku.skuCode)
        );

        if (newSkus.length > 0) {
          const result = await SKU.insertMany(newSkus, { ordered: false });
          console.log(`${result.length} new SKUs seeded`);
        } else {
          console.log("All SKUs already exist");
        }
      } else {
        console.error("Unexpected error inserting SKUs:", error.message);
        throw error;
      }
    }

    // Seed Customer Groups (align with CustomerGroup model)
    let customerGroupMap = new Map();
    const customerGroupSeedData = [
      {
        name: "Cash",
        code: "CSH",
        description: "Cash customers - payment on delivery",
        active: true,
      },
      {
        name: "Large",
        code: "LGE",
        description: "Large customers with special terms",
        active: true,
      },
      {
        name: "Wholesale",
        code: "WHL",
        description: "Wholesale customers with negotiated rates",
        active: true,
      },
    ];
    try {
      const customerGroups = await CustomerGroup.insertMany(
        customerGroupSeedData,
        { ordered: false }
      );
      console.log("Customer groups seeded");

      // Create customer group map for easy lookup
      customerGroupMap = new Map(customerGroups.map((cg) => [cg.name, cg._id]));
    } catch (error) {
      if (error.code === 11000) {
        console.log("Customer groups already exist, fetching existing...");
        // Fetch existing customer groups
        const existingGroups = await CustomerGroup.find({});
        customerGroupMap = new Map(
          existingGroups.map((cg) => [cg.name, cg._id])
        );
      } else {
        throw error;
      }
    }

    // Ensure required customer groups exist even if they were pre-existing
    if (customerGroupMap.size === 0) {
      const existingGroups = await CustomerGroup.find({});
      customerGroupMap = new Map(existingGroups.map((cg) => [cg.name, cg._id]));
    }

    for (const groupSeed of customerGroupSeedData) {
      if (!customerGroupMap.has(groupSeed.name)) {
        const createdGroup = await CustomerGroup.findOneAndUpdate(
          { code: groupSeed.code },
          groupSeed,
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        customerGroupMap.set(createdGroup.name, createdGroup._id);
      }
    }

    // Seed Suppliers with duplicate handling (align with Supplier model)
    try {
      await Supplier.insertMany([
        {
          supplierCode: "GPM001",
          name: "Gujarat Paper Mills",
          gstin: "24ABCDE1234F1Z5",
          pan: "ABCDE1234F",
          state: "Gujarat",
          address: {
            line1: "Ring Road",
            line2: "",
            city: "Surat",
            pincode: "395002",
          },
          contactPersons: [
            {
              name: "Ramesh Patel",
              designation: "Sales Manager",
              phone: "9876543210",
              isPrimary: true,
            },
          ],
          paymentTerms: { creditDays: 30, creditLimit: 1000000 },
          leadTime: 7,
          active: true,
        },
        {
          supplierCode: "PIT001",
          name: "Premium Imports Trading",
          gstin: "24ABCDE1234F1Z6",
          pan: "ABCDE1234F",
          state: "Gujarat",
          address: {
            line1: "Udhna",
            line2: "",
            city: "Surat",
            pincode: "394210",
          },
          contactPersons: [
            {
              name: "Suresh Shah",
              designation: "Owner",
              phone: "9876543211",
              isPrimary: true,
            },
          ],
          paymentTerms: { creditDays: 15, creditLimit: 500000 },
          leadTime: 10,
          active: true,
        },
      ]);
      console.log("Suppliers seeded");
    } catch (error) {
      if (error.code === 11000) {
        console.log("Suppliers already exist, skipping...");
      } else {
        throw error;
      }
    }

    // Seed Customers with duplicate handling (align with Customer model)
    try {
      const wholesaleGroupId = customerGroupMap.get("Wholesale");
      const cashGroupId = customerGroupMap.get("Cash");

      if (!wholesaleGroupId || !cashGroupId) {
        throw new Error(
          "Customer groups not found. Please seed customer groups first."
        );
      }

      const insertedCustomers = await Customer.insertMany([
        {
          companyName: "ABC Printers Pvt Ltd",
          gst: "REGULAR",
          customerGroupIds: [wholesaleGroupId],
          state: "Gujarat",
          address: {
            billing: {
              line1: "Varachha",
              line2: "",
              city: "Surat",
              pincode: "395006",
            },
            shipping: [
              {
                label: "Main Warehouse",
                line1: "Varachha",
                city: "Surat",
                pincode: "395006",
                isDefault: true,
              },
            ],
          },
          contactPersons: [
            {
              name: "Amit Kumar",
              designation: "Owner",
              phone: "9876543220",
              email: "amit@abcprinters.com",
              isPrimary: true,
            },
          ],
          customerGroupId: wholesaleGroupId,
          creditPolicy: {
            creditLimit: 500000,
            creditDays: 30,
            graceDays: 7,
            autoBlock: true,
            blockRule: "BOTH",
          },
          active: true,
        },
        {
          companyName: "XYZ Digital Solutions",
          gst: "COMPOSITE",
          customerGroupIds: [cashGroupId],
          state: "Gujarat",
          address: {
            billing: {
              line1: "Katargam",
              line2: "",
              city: "Surat",
              pincode: "395004",
            },
            shipping: [
              {
                label: "Office",
                line1: "Katargam",
                city: "Surat",
                pincode: "395004",
                isDefault: true,
              },
            ],
          },
          contactPersons: [
            {
              name: "Priya Sharma",
              designation: "Manager",
              phone: "9876543221",
              email: "priya@xyzdigital.com",
              isPrimary: true,
            },
          ],
          customerGroupId: cashGroupId,
          creditPolicy: {
            creditLimit: 0,
            creditDays: 0,
            graceDays: 0,
            autoBlock: false,
            blockRule: "BOTH",
          },
          active: true,
        },
      ]);
      console.log("Customers seeded");

      try {
        if (insertedCustomers.length > 0) {
          const [abcCustomer, xyzCustomer] = insertedCustomers;

          const currentDate = new Date();
          const lastMonthStart = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth() - 1,
            1
          );
          const lastMonthEnd = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            0
          );

          await Agent.insertMany([
            {
              name: "Prime Sales Agency",
              state: "Gujarat",
              address: {
                line1: "201, Prime Plaza",
                line2: "Ring Road",
                city: "Surat",
                pincode: "395002",
              },
              phone: "9876500001",
              whatsapp: "9876500001",
              email: "rahul.desai@primesales.in",
              targetSalesMeters: 50000,
              defaultRate: 118,
              defaultCreditLimit: 400000,
              defaultCreditDays: 30,
              customers: [abcCustomer._id],
              notes: "Handles major export-oriented accounts",
              kycDocuments: [
                {
                  documentType: "pan",
                  fileName: "prime-pan.pdf",
                  fileUrl:
                    "https://storage.example.com/kyc/prime_sales/prime-pan.pdf",
                  notes: "PAN verification document",
                },
              ],
              partyCommissions: [
                {
                  customer: abcCustomer._id,
                  commissionType: "per_meter",
                  amountPerMeter: 2.5,
                  applyByDefault: true,
                  history: [
                    {
                      commissionType: "per_meter",
                      amountPerMeter: 2.5,
                      effectiveFrom: new Date(
                        currentDate.getFullYear(),
                        currentDate.getMonth() - 2,
                        1
                      ),
                      notes: "Initial commission setup",
                    },
                  ],
                },
              ],
              commissionChanges: [
                {
                  customer: abcCustomer._id,
                  newCommissionType: "per_meter",
                  newAmountPerMeter: 2.5,
                  changeDate: new Date(
                    currentDate.getFullYear(),
                    currentDate.getMonth() - 2,
                    1
                  ),
                  notes: "Commission plan initiated",
                },
              ],
              commissionPayouts: [
                {
                  customer: abcCustomer._id,
                  reference: "FY24-Q4",
                  periodStart: lastMonthStart,
                  periodEnd: lastMonthEnd,
                  amount: 25000,
                  payoutStatus: "paid",
                  paidOn: currentDate,
                  paymentReference: "UTR123456789",
                  notes: "Quarterly commission settlement",
                },
              ],
            },
            {
              name: "Galaxy Brokerage",
              state: "Maharashtra",
              address: {
                line1: "804, Galaxy Heights",
                line2: "Andheri East",
                city: "Mumbai",
                pincode: "400069",
              },
              phone: "9876501001",
              whatsapp: "9876501001",
              email: "sejal.shah@galaxybrokerage.in",
              targetSalesMeters: 35000,
              defaultRate: 120,
              defaultCreditLimit: 250000,
              defaultCreditDays: 20,
              blockNewSalesForAllParties: false,
              blockNewDeliveriesForAllParties: false,
              blockedSalesCustomers: xyzCustomer ? [xyzCustomer._id] : [],
              customers: xyzCustomer ? [xyzCustomer._id] : [],
              kycDocuments: [
                {
                  documentType: "aadhaar",
                  fileName: "galaxy-aadhaar.pdf",
                  fileUrl:
                    "https://storage.example.com/kyc/galaxy/galaxy-aadhaar.pdf",
                },
                {
                  documentType: "pan",
                  fileName: "galaxy-pan.pdf",
                  fileUrl:
                    "https://storage.example.com/kyc/galaxy/galaxy-pan.pdf",
                },
              ],
              partyCommissions: xyzCustomer
                ? [
                    {
                      customer: xyzCustomer._id,
                      commissionType: "percentage",
                      percentage: 1.75,
                      applyByDefault: true,
                      history: [
                        {
                          commissionType: "percentage",
                          percentage: 1.75,
                          effectiveFrom: new Date(
                            currentDate.getFullYear(),
                            currentDate.getMonth() - 1,
                            15
                          ),
                          notes: "Introductory commission",
                        },
                      ],
                    },
                  ]
                : [],
              commissionChanges: xyzCustomer
                ? [
                    {
                      customer: xyzCustomer._id,
                      newCommissionType: "percentage",
                      newPercentage: 1.75,
                      changeDate: new Date(
                        currentDate.getFullYear(),
                        currentDate.getMonth() - 1,
                        15
                      ),
                      notes: "Initial commission setup",
                    },
                  ]
                : [],
              commissionPayouts: xyzCustomer
                ? [
                    {
                      customer: xyzCustomer._id,
                      reference: "APR-2025",
                      periodStart: lastMonthStart,
                      periodEnd: lastMonthEnd,
                      amount: 15000,
                      payoutStatus: "pending",
                      notes: "Pending verification from accounts",
                    },
                  ]
                : [],
            },
          ]);
          console.log("Agents seeded");
        }
      } catch (error) {
        if (error.code === 11000) {
          console.log("Agents already exist, skipping...");
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error.code === 11000) {
        console.log("Customers already exist, skipping...");
      } else {
        throw error;
      }
    }

    // Seed Customer Rates for each customer-product (for pricing)
    try {
      const customerRates = [];
      const customers = await Customer.find({}).populate("customerGroupId");
      for (const customer of customers) {
        // Set baseRate44 seed per customer group
        // Wholesale group gets 120, others get 125
        const customerGroupName = customer.customerGroupId?.name || "";
        const defaultRate = customerGroupName === "Wholesale" ? 120 : 125;
        for (const product of insertedProducts) {
          customerRates.push({
            customerId: customer._id,
            productId: product._id,
            baseRate44: defaultRate,
            active: true,
          });
        }
      }

      if (customerRates.length > 0) {
        await CustomerRate.insertMany(customerRates, { ordered: false });
        console.log(`${customerRates.length} customer rates seeded`);
      }
    } catch (error) {
      if (error.code === 11000) {
        console.log("Customer rates already exist, skipping duplicates...");
      } else {
        throw error;
      }
    }

    // Seed System Ledgers with duplicate handling
    try {
      await Ledger.insertMany([
        // Assets
        {
          ledgerCode: "INVENTORY",
          name: "Inventory",
          group: "Assets",
          isSystemLedger: true,
        },
        {
          ledgerCode: "CASH",
          name: "Cash in Hand",
          group: "Assets",
          isSystemLedger: true,
        },
        {
          ledgerCode: "BANK",
          name: "Bank Accounts",
          group: "Assets",
          isSystemLedger: true,
        },
        {
          ledgerCode: "AR",
          name: "Accounts Receivable",
          group: "Assets",
          isSystemLedger: true,
        },
        {
          ledgerCode: "INPUT_TAX",
          name: "Input Tax",
          group: "Assets",
          isSystemLedger: true,
        },

        // Liabilities
        {
          ledgerCode: "AP",
          name: "Accounts Payable",
          group: "Liabilities",
          isSystemLedger: true,
        },
        {
          ledgerCode: "OUTPUT_TAX",
          name: "Output Tax",
          group: "Liabilities",
          isSystemLedger: true,
        },

        // Income
        {
          ledgerCode: "SALES",
          name: "Sales - Domestic",
          group: "Income",
          isSystemLedger: true,
        },
        {
          ledgerCode: "DISC_RCVD",
          name: "Discounts Received",
          group: "Income",
          isSystemLedger: true,
        },

        // Expenses
        {
          ledgerCode: "COGS",
          name: "Cost of Goods Sold",
          group: "Expenses",
          isSystemLedger: true,
        },
        {
          ledgerCode: "FREIGHT",
          name: "Freight Inward",
          group: "Expenses",
          isSystemLedger: true,
        },
        {
          ledgerCode: "CLEARING",
          name: "Clearing & Forwarding",
          group: "Expenses",
          isSystemLedger: true,
        },
        {
          ledgerCode: "DUTY",
          name: "Customs Duty",
          group: "Expenses",
          isSystemLedger: true,
        },
        {
          ledgerCode: "DISC_GIVEN",
          name: "Discounts Allowed",
          group: "Expenses",
          isSystemLedger: true,
        },

        // Equity
        {
          ledgerCode: "CAPITAL",
          name: "Capital Account",
          group: "Equity",
          isSystemLedger: true,
        },
        {
          ledgerCode: "RETAINED",
          name: "Retained Earnings",
          group: "Equity",
          isSystemLedger: true,
        },
      ]);
      console.log("System ledgers seeded");
    } catch (error) {
      if (error.code === 11000) {
        console.log("System ledgers already exist, skipping...");
      } else {
        throw error;
      }
    }

    console.log("Seeding completed successfully");
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error("Error seeding data:", error.message);
    await mongoose.connection.close();
    process.exit(1);
  }
};

seedData();
