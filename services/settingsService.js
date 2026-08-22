const StoreSetting = require('../models/StoreSetting');

const getSettings = async () => {
  let settings = await StoreSetting.findByPk(1);
  if (!settings) {
    settings = await StoreSetting.create({
      id: 1,
      is_banner_enabled: true,
    });
  }
  return settings;
};

const updateSettings = async (updates) => {
  let settings = await StoreSetting.findByPk(1);
  if (!settings) {
    settings = await StoreSetting.create({
      id: 1,
      is_banner_enabled: updates.is_banner_enabled !== undefined ? updates.is_banner_enabled : true,
    });
  } else {
    await settings.update(updates);
  }
  return settings;
};

module.exports = {
  getSettings,
  updateSettings,
};
