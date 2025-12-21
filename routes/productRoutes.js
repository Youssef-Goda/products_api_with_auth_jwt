const express = require('express');
const Product = require('../models/Product');

const router = express.Router();

router.get('/', async (req, res) => {
    const products = await Product.findAll();
    res.json(products);
});

router.post('/', async (req, res) => {
    const { name, description, price } = req.body;
    const product = await Product.create({ name, description, price });
    res.status(201).json(product);
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, price } = req.body;
    const product = await Product.findByPk(id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await product.update({ name, description, price });
    res.json(product);
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const product = await Product.findByPk(id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await product.destroy();
    res.json({ message: 'Product deleted' });
});

module.exports = router;
