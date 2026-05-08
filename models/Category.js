const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Category = sequelize.define('Category', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'id'
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'name'
    },
    slug: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false,
        field: 'slug'
    },
    iconUrl: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'iconUrl'
    },
    parentId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'parentId',
        references: {
            model: 'categories',
            key: 'id'
        },
        onDelete: 'SET NULL'
    }
}, {
    tableName: 'categories',
    timestamps: true,
    underscored: false
});

// Self-referencing associations: parent ↔ children
Category.hasMany(Category, { as: 'children', foreignKey: 'parentId' });
Category.belongsTo(Category, { as: 'parent', foreignKey: 'parentId' });

module.exports = Category;
