const jwt = require('jsonwebtoken');
const { ApiError } = require('./errors');

function authMiddleware(db, secret) {
  return (req, res, next) => {
    const token = req.cookies?.token;
    if (!token) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in'));
    try {
      const payload = jwt.verify(token, secret);
      // Role is always re-read from the database; never trusted from the token.
      const user = db.prepare('SELECT id, name, email, role, is_active FROM users WHERE id = ?').get(payload.sub);
      if (!user || !user.is_active) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in'));
      req.user = user;
      next();
    } catch {
      next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in'));
    }
  };
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(new ApiError(403, 'FORBIDDEN', 'Admin access required'));
  next();
}

// Basic CSRF defence on top of SameSite=Strict cookies.
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) return next(new ApiError(403, 'BAD_ORIGIN', 'Cross-origin request blocked'));
  }
  next();
}

function errorHandler(logger) {
  return (err, req, res, _next) => {
    if (err instanceof ApiError) {
      if (err.status === 403 || err.status === 429) logger.warn({ msg: 'security', status: err.status, code: err.code, user: req.user?.id, path: req.path });
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body' } });
    }
    logger.error({ msg: 'unhandled', error: err.message, path: req.path });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
  };
}

function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, user: req.user?.id });
    });
    next();
  };
}

module.exports = { authMiddleware, requireAdmin, originCheck, errorHandler, requestLogger };
