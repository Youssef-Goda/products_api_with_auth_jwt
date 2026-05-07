const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    const secret = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
    jwt.verify(token, secret, (err, user) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ success: false, message: 'Session expired' });
            }
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        req.user = user;
        next();
    });
};

module.exports = { authenticateToken };
