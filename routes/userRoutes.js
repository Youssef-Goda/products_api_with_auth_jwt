const express = require('express');
const router = express.Router();
const User = require('../models/User');

// جلب كل المستخدمين
router.get('/', async (req, res) => {
  try {
    const users = await User.findAll({
      // ركز هنا: لازم الحقول دي تكون بنفس الاسم اللي عرفناه في models/User.js
      attributes: [
        'id',
        'serial_id',
        'code',
        'firstName',
        'lastName',
        'email',
        'role',
        'isActive',
        'createdAt',
        'updatedAt'
      ],
      // ترتيب تلقائي بالسيريال (التفنيط) عشان يريحك في فلاتر
      order: [['serial_id', 'DESC']]
    });
    
    // ده عشانك إنت في الـ Terminal تشوف الداتا وهي ماشية
    console.log(`✅ Successfully fetched ${users.length} users`);
    res.json(users);
    
  } catch (err) {
    // لو حصلت مشكلة، الإيرور ده هيظهرلك في شاشة السيرفر السودة
    console.error("❌ Database Error Details:", err.message);
    res.status(500).json({ 
        error: 'Server error', 
        details: err.message // بعتنا التفاصيل عشان تعرف المشكلة فين بالظبط
    });
  }
});

// 1. مسح مستخدم
router.delete('/:id', async (req, res) => {
  try {
    const result = await User.destroy({ where: { id: req.params.id } });
    if (result) {
      res.json({ success: true, message: "تم مسح المستخدم بنجاح" });
    } else {
      res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    }
  } catch (err) {
    console.error("❌ Delete Error:", err);
    res.status(500).json({ error: "فشل في مسح المستخدم" });
  }
});

// 2. تحديث الرتبة
router.put('/update-role/:id', async (req, res) => {
  try {
    const { role } = req.body;
    // تحديث الرتبة مع ضمان إن الكود هيتغير أوتوماتيك في سوبا بيز (بسبب الـ Generated Column)
    await User.update({ role: role }, { where: { id: req.params.id } });
    res.json({ success: true, message: "تم تحديث الرتبة بنجاح" });
  } catch (err) {
    console.error("❌ Update Role Error:", err);
    res.status(500).json({ error: "فشل في تحديث الرتبة" });
  }
});

// 3. تفعيل/إيقاف الحساب
router.put('/toggle-status/:id', async (req, res) => {
  try {
    const { isActive } = req.body;
    await User.update({ isActive: isActive }, { where: { id: req.params.id } });
    res.json({ success: true, message: "تم تغيير حالة الحساب" });
  } catch (err) {
    console.error("❌ Toggle Error:", err);
    res.status(500).json({ error: "فشل في تغيير الحالة" });
  }
});

module.exports = router;