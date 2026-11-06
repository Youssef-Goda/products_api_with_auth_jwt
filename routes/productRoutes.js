const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Category = require('../models/Category');
const { uploadImage } = require('../controllers/uploadController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { checkRole } = require('../middlewares/checkRole');
const { logActivity } = require('../services/activityLogger');
const { parsePurchaseCost } = require('../services/productCost');
const { canManageProductCost, serializePublicProduct, serializeInternalProduct } = require('../services/productCostAccess');

// Define association for eager loading
Product.belongsTo(Category, { foreignKey: 'categoryId', as: 'category' });


// 0. Upload image to ImgBB (JWT protected)
router.post('/upload', authenticateToken, uploadImage);

// 1. GET /all ── Fetch all products with their category
router.get('/all', async (req, res) => {
    try {
        const products = await Product.findAll({
            include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'slug'] }],
            order: [['serial_id', 'DESC']]
        });
        res.status(200).json(products.map(serializePublicProduct));
    } catch (error) {
        console.error('❌ Fetch Products Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Private cost view. Product cost changes are restricted to the existing owner role.
router.get('/admin/all', authenticateToken, checkRole(['owner']), async (req, res) => {
    try {
        const products = await Product.findAll({ include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'slug'] }], order: [['serial_id', 'DESC']] });
        res.json(products.map(serializeInternalProduct));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. GET /:id ── Fetch single product
router.get('/:id', async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id, {
            include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'slug'] }]
        });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json(serializePublicProduct(product));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. POST /add ── Add a new product (Admin / Super-Admin only)
router.post('/add', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
    try {
        const { name, description, price, imageUrls, oldPrice, rating, countInStock, categoryId, attributes } = req.body;
        const costPrice = req.body.costPrice === undefined ? null : parsePurchaseCost(req.body.costPrice);

        // categoryId is optional — validate it only when provided
        if (categoryId) {
            const category = await Category.findByPk(categoryId);
            if (!category) {
                return res.status(400).json({ error: 'Category not found' });
            }
        }

        const sequelize = require('../config/database');
        const newProduct = await sequelize.transaction(async (transaction) => {
          const created = await Product.create({
            name,
            description,
            price: (price !== undefined && price !== null && price !== '') ? parseFloat(price) : 0.0,
            costPrice,
            imageUrls: imageUrls || [],
            oldPrice: (oldPrice !== undefined && oldPrice !== null && oldPrice !== '') ? parseFloat(oldPrice) : null,
            rating: (rating !== undefined && rating !== null && rating !== '') ? parseFloat(rating) : 0.0,
            countInStock: (countInStock !== undefined && countInStock !== null && countInStock !== '') ? parseInt(countInStock) : 0,
            categoryId: categoryId || null,
            attributes: attributes || {}
          }, { transaction });

          if (costPrice !== null) {
            await sequelize.query('INSERT INTO "ProductCostAuditLogs" ("productId", "previousCost", "newCost", "changedBy", "createdAt") VALUES (:productId, NULL, :newCost, :changedBy, NOW())', {
                replacements: { productId: created.id, newCost: costPrice, changedBy: req.user.id }, transaction
            });
          }
          return created;
        });

        // Log the activity
        await logActivity(req.user.id, 'CREATE_PRODUCT', 'product', newProduct.id, {
            name: newProduct.name,
            price: newProduct.price,
            countInStock: newProduct.countInStock
        });

        // Return with category info attached
        const result = await Product.findByPk(newProduct.id, {
            include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'slug'] }]
        });

        res.status(201).json(canManageProductCost(req.user?.role) ? serializeInternalProduct(result) : serializePublicProduct(result));
    } catch (error) {
        console.error('❌ Add Product Error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// 4. PUT /:id ── Update product (Admin / Super-Admin only)
router.put('/:id', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, imageUrls, oldPrice, rating, countInStock, categoryId, attributes } = req.body;

        const product = await Product.findByPk(id);
        if (!product) return res.status(404).json({ error: 'Product not found' });

        if (Object.prototype.hasOwnProperty.call(req.body, 'costPrice') && !canManageProductCost(req.user?.role)) {
            return res.status(403).json({ error: 'Only an owner can view or edit purchase cost.' });
        }
        const nextCost = Object.prototype.hasOwnProperty.call(req.body, 'costPrice') ? parsePurchaseCost(req.body.costPrice) : product.costPrice;
        const previousCost = product.costPrice == null ? null : Number(product.costPrice);

        if (categoryId && categoryId !== product.categoryId) {
            const category = await Category.findByPk(categoryId);
            if (!category) return res.status(400).json({ error: 'Category not found' });
        }

        const previousData = {
            name: product.name,
            price: product.price,
            countInStock: product.countInStock
        };

        const sequelize = require('../config/database');
        await sequelize.transaction(async (transaction) => {
          await product.update({
            costPrice: nextCost,
            name: name !== undefined ? name : product.name,
            description: description !== undefined ? description : product.description,
            price: (price !== undefined && price !== null && price !== '') ? parseFloat(price) : product.price,
            imageUrls: imageUrls !== undefined ? imageUrls : product.imageUrls,
            oldPrice: oldPrice !== undefined ? (oldPrice !== null && oldPrice !== '' ? parseFloat(oldPrice) : null) : product.oldPrice,
            rating: rating !== undefined ? (rating !== null && rating !== '' ? parseFloat(rating) : 0.0) : product.rating,
            countInStock: countInStock !== undefined ? (countInStock !== null && countInStock !== '' ? parseInt(countInStock) : 0) : product.countInStock,
            categoryId: categoryId !== undefined ? (categoryId || null) : product.categoryId,
            attributes: attributes !== undefined ? attributes : product.attributes
          }, { transaction });

          if (Object.prototype.hasOwnProperty.call(req.body, 'costPrice') && previousCost !== (nextCost == null ? null : Number(nextCost))) {
            await sequelize.query('INSERT INTO "ProductCostAuditLogs" ("productId", "previousCost", "newCost", "changedBy", "createdAt") VALUES (:productId, :previousCost, :newCost, :changedBy, NOW())', {
                replacements: { productId: id, previousCost, newCost: nextCost, changedBy: req.user.id },
                transaction,
            });
          }
        });

        // Log the activity
        await logActivity(req.user.id, 'UPDATE_PRODUCT', 'product', id, {
            name: product.name,
            changes: {
                previous: previousData,
                current: {
                    name: product.name,
                    price: product.price,
                    countInStock: product.countInStock
                }
            }
        });

        const result = await Product.findByPk(id, {
            include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'slug'] }]
        });

        res.json(canManageProductCost(req.user?.role) ? serializeInternalProduct(result) : serializePublicProduct(result));
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 5. DELETE /:id ── Delete product (Admin / Super-Admin only)
router.delete('/:id', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const product = await Product.findByPk(id);
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const productName = product.name;
        await product.destroy();

        // Log the activity
        await logActivity(req.user.id, 'DELETE_PRODUCT', 'product', id, { name: productName });

        res.json({ success: true, message: 'Product deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
