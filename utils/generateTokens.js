const jwt = require('jsonwebtoken');

const generateAccessToken = (user) => {
    const secret = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
    return jwt.sign({ id: user.id, username: user.username }, secret, { expiresIn: '30d' });
};

const generateRefreshToken = (user) => {
    const secret = process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET;
    return jwt.sign({ id: user.id, username: user.username }, secret, { expiresIn: '60d' });
};

module.exports = { generateAccessToken, generateRefreshToken };
