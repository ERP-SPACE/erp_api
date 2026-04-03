const express = require("express");
const router = express.Router();
const categoryController = require("../controllers/categoryController");
const { validateCategory } = require("../validators/categoryValidator");
const { authenticate } = require("../middlewares/auth");

// All routes require authentication
router.use(authenticate);

router.get("/", categoryController.getAllCategories);
router.get("/:id", categoryController.getCategoryById);

router.post("/", validateCategory, categoryController.createCategory);
router.patch("/:id", categoryController.updateCategory);
router.patch("/:id/toggle-status", categoryController.toggleCategoryStatus);
router.delete("/:id", categoryController.deleteCategory);

module.exports = router;
