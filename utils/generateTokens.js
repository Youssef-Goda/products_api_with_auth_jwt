const jwt = require('jsonwebtoken');

const generateAccessToken = (user) => {
    const secret = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET || 'Dealio_Access_Key_2026_Kernel';
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            // Embed role so checkRole middleware never needs a DB round-trip.
            // If role changes, user must re-login to receive an updated token.
            role: user.role ?? 'user'
        },
        secret,
        { expiresIn: '30d' }
    );
};

const generateRefreshToken = (user) => {
    const secret = process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'Dealio_Refresh_Key_2026_Kernel';

    return jwt.sign(
        { id: user.id },
        secret,
        { expiresIn: '60d' }
    );
};

module.exports = { generateAccessToken, generateRefreshToken };