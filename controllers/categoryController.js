const Category = require('../models/Category');
const Product = require('../models/Product');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityLogger');

// Helper: generate slug from name
const generateSlug = (name) =>
    name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

// ── GET /api/categories ── List all (nested tree)
const getAllCategories = async (req, res) => {
    try {
        const categories = await Category.findAll({
            where: { parentId: null },
            include: [{
                model: Category,
                as: 'children',
                include: [{ model: Category, as: 'children' }] // Up to 3 levels deep
            }],
            order: [['name', 'ASC']]
        });
        res.json({ success: true, data: categories });
    } catch (err) {
        console.error('❌ Get Categories Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/categories/flat ── Flat list (useful for dropdowns)
const getFlatCategories = async (req, res) => {
    try {
        const categories = await Category.findAll({
            include: [{ model: Category, as: 'parent', attributes: ['id', 'name'] }],
            order: [['name', 'ASC']]
        });
        res.json({ success: true, data: categories });
    } catch (err) {
        console.error('❌ Get Flat Categories Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/categories/:id ── Single category
const getCategoryById = async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id, {
            include: [
                { model: Category, as: 'parent', attributes: ['id', 'name', 'slug'] },
                { model: Category, as: 'children', attributes: ['id', 'name', 'slug', 'iconUrl'] }
            ]
        });
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, data: category });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /api/categories ── Create category (Admin only)
const createCategory = async (req, res) => {
    try {
        // Accept imageUrl as an alias for iconUrl (frontend may send either)
        const { name, iconUrl, imageUrl, parentId } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

        const finalIconUrl = iconUrl || imageUrl || null;

        // Enforce name uniqueness (case-insensitive)
        const nameExists = await Category.findOne({
            where: { name: name.trim() },
        });
        if (nameExists) {
            return res.status(400).json({ success: false, message: 'A category with this name already exists' });
        }

        let slug = generateSlug(name);

        // Ensure slug uniqueness by appending a timestamp suffix if needed
        const existingSlug = await Category.findOne({ where: { slug } });
        if (existingSlug) slug = `${slug}-${Date.now()}`;

        // Validate parentId if provided
        if (parentId) {
            const parent = await Category.findByPk(parentId);
            if (!parent) return res.status(400).json({ success: false, message: 'Parent category not found' });
        }

        const category = await Category.create({
            name: name.trim(),
            slug,
            iconUrl: finalIconUrl,
            parentId: parentId || null
        });

        // Log activity
        await logActivity(req.user.id, 'CREATE_CATEGORY', 'category', category.id, { name: category.name });

        res.status(201).json({ success: true, data: category });
    } catch (err) {
        console.error('❌ Create Category Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── PUT /api/categories/:id ── Update category (Admin only)
const updateCategory = async (req, res) => {
    try {
        const { name, iconUrl, imageUrl, parentId } = req.body;
        const category = await Category.findByPk(req.params.id);
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

        // Prevent category from being its own parent
        if (parentId && parentId === req.params.id) {
            return res.status(400).json({ success: false, message: 'Category cannot be its own parent' });
        }

        if (parentId) {
            const parent = await Category.findByPk(parentId);
            if (!parent) return res.status(400).json({ success: false, message: 'Parent category not found' });
        }

        const previousData = { name: category.name, iconUrl: category.iconUrl, parentId: category.parentId };

        const updates = {};
        if (name && name.trim() !== category.name) {
            const trimmedName = name.trim();
            const nameExists = await Category.findOne({
                where: { name: trimmedName },
            });
            if (nameExists) {
                return res.status(400).json({ success: false, message: 'A category with this name already exists' });
            }

            updates.name = trimmedName;
            let newSlug = generateSlug(trimmedName);
            const existing = await Category.findOne({ where: { slug: newSlug, id: { [Op.ne]: req.params.id } } });
            updates.slug = existing ? `${newSlug}-${Date.now()}` : newSlug;
        }

        const finalIconUrl = iconUrl !== undefined ? (iconUrl || null) : (imageUrl !== undefined ? (imageUrl || null) : undefined);
        if (finalIconUrl !== undefined) updates.iconUrl = finalIconUrl;
        
        if (parentId !== undefined) updates.parentId = parentId || null;

        await category.update(updates);

        // Log activity
        await logActivity(req.user.id, 'UPDATE_CATEGORY', 'category', category.id, {
            name: category.name,
            changes: { previous: previousData, current: updates }
        });

        res.json({ success: true, data: category });
    } catch (err) {
        console.error('❌ Update Category Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── DELETE /api/categories/:id ── Delete category (Admin only)
const deleteCategory = async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

        // Guard: Prevent deletion if products are assigned to this category
        const productCount = await Product.count({ where: { categoryId: req.params.id } });
        if (productCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete category. ${productCount} product(s) are assigned to it.`
            });
        }

        // Reassign children to grandparent (or null) before deleting
        await Category.update(
            { parentId: category.parentId || null },
            { where: { parentId: req.params.id } }
        );

        const categoryName = category.name;
        await category.destroy();

        // Log activity
        await logActivity(req.user.id, 'DELETE_CATEGORY', 'category', req.params.id, { name: categoryName });

        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (err) {
        console.error('❌ Delete Category Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    getAllCategories,
    getFlatCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory
};
