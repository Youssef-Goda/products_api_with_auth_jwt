const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const {
    getAllCategories,
    getFlatCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory
} = require('../controllers/categoryController');

// ── Admin-only guard middleware ──
const adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
};

// Public routes (anyone can browse categories)
router.get('/', getAllCategories);
router.get('/flat', getFlatCategories);
router.get('/:id', getCategoryById);

// Admin-only routes (require valid JWT + admin role)
router.post('/', authenticateToken, adminOnly, createCategory);
router.put('/:id', authenticateToken, adminOnly, updateCategory);
router.delete('/:id', authenticateToken, adminOnly, deleteCategory);

module.exports = router;
