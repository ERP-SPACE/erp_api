// routes/productRoutes.js
const express = require("express");
const router = express.Router();
const productController = require("../controllers/productController");
const { authenticate } = require("../middlewares/auth");

// All routes require authentication
router.use(authenticate);

router.get("/", productController.getAllProducts);
router.get("/:id", productController.getProductById);
router.get(
  "/category/:categoryId/gsm/:gsm",
  productController.getProductsByCategoryAndGSM
);

router.post("/", productController.createProduct);
router.post("/bulk", productController.bulkCreateProducts);
router.patch("/:id", productController.updateProduct);
router.patch("/:id/toggle-status", productController.toggleProductStatus);
router.delete("/:id", productController.deleteProduct);

module.exports = router;
