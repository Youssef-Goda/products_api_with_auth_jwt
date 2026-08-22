const settingsService = require('../services/settingsService');
const { logActivity } = require('../services/activityLogger');

const getPublicSettings = async (req, res) => {
  try {
    const settings = await settingsService.getSettings();
    return res.json({
      success: true,
      data: {
        is_banner_enabled: settings.is_banner_enabled,
        updated_at: settings.updated_at,
      },
    });
  } catch (err) {
    console.error('❌ Get Public Settings Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateOwnerSettings = async (req, res) => {
  try {
    const { is_banner_enabled, isBannerEnabled } = req.body;
    const updates = {};
    if (is_banner_enabled !== undefined) {
      updates.is_banner_enabled = Boolean(is_banner_enabled);
    } else if (isBannerEnabled !== undefined) {
      updates.is_banner_enabled = Boolean(isBannerEnabled);
    }

    const settings = await settingsService.updateSettings(updates);

    if (req.user?.id) {
      await logActivity(req.user.id, 'UPDATE_STORE_SETTINGS', 'store_settings', 1, updates);
    }

    return res.json({
      success: true,
      message: 'Store settings updated successfully',
      data: {
        is_banner_enabled: settings.is_banner_enabled,
        updated_at: settings.updated_at,
      },
    });
  } catch (err) {
    console.error('❌ Update Owner Settings Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getPublicSettings,
  updateOwnerSettings,
};
