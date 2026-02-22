const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// 1. جلب كل المنتجات (مرتبة بالأحدث حسب السيريال)
router.get('/all', async (req, res) => {
    try {
        const products = await Product.findAll({
            // بنجيب كل الحقول بما فيها product_code و serial_id
            order: [['serial_id', 'DESC']]
        });
        res.status(200).json(products);
    } catch (error) {
        console.error("❌ Fetch Products Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. إضافة منتج جديد
router.post('/add', async (req, res) => {
    try {
        const { name, description, price, imageUrls, oldPrice, rating, countInStock } = req.body;

        const newProduct = await Product.create({
            // ملحوظة: مش بنبعت id ولا product_code ولا serial_id
            // سوبا بيز هتولدهم أوتوماتيك
            name,
            description,
            price: parseFloat(price),
            imageUrls: imageUrls || [],
            oldPrice: oldPrice ? parseFloat(oldPrice) : null,
            rating: rating ? parseFloat(rating) : 0.0,
            countInStock: countInStock ? parseInt(countInStock) : 0
        });
        res.status(201).json(newProduct);
    } catch (error) {
        console.error("❌ Add Product Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

// 3. تعديل منتج
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, imageUrls, oldPrice, rating, countInStock } = req.body;

        const product = await Product.findByPk(id);
        if (!product) return res.status(404).json({ error: 'Product not found' });

        await product.update({
            name,
            description,
            price: parseFloat(price),
            imageUrls: imageUrls,
            oldPrice: oldPrice ? parseFloat(oldPrice) : product.oldPrice,
            rating: rating ? parseFloat(rating) : product.rating,
            countInStock: countInStock !== undefined ? parseInt(countInStock) : product.countInStock
        });
        res.json(product);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// 4. حذف منتج
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await Product.destroy({ where: { id: id } });
        if (!result) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true, message: 'Product deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;