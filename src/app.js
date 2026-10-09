const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { ApiError } = require('./errors');
const { authMiddleware, requireAdmin, originCheck, errorHandler, requestLogger } = require('./middleware');
const { validateKudosInput, validateReason, hashMessage, containsBlockedWord } = require('./validation');

const DEFAULTS = {
  jwtSecret: 'dev-only-secret-change-me',
  autoHideThreshold: 3,
  perMinuteLimit: 3,
  perHourLimit: 10,
  perRecipientPerDay: 5,
  loginMaxAttempts: 5,
  secureCookies: false,
  logger: { info: (o) => console.log(JSON.stringify(o)), warn: (o) => console.warn(JSON.stringify(o)), error: (o) => console.error(JSON.stringify(o)) },
};

// Feed/admin row -> JSON shape used by the frontend
function toKudosJson(r, { admin = false } = {}) {
  const base = {
    id: r.id,
    sender: { id: r.sender_id, name: r.sender_name },
    recipient: { id: r.recipient_id, name: r.recipient_name, former: !r.recipient_active },
    message: r.message,
    createdAt: r.created_at.replace(' ', 'T') + 'Z',
  };
  if (!admin) return base;
  return {
    ...base,
    isVisible: !!r.is_visible,
    reportCount: r.report_count,
    moderatedBy: r.moderator_name || null,
    moderatedAt: r.moderated_at ? r.moderated_at.replace(' ', 'T') + 'Z' : null,
    moderationReason: r.moderation_reason,
  };
}

const KUDOS_SELECT = `
  SELECT k.*, s.name AS sender_name, r.name AS recipient_name, r.is_active AS recipient_active, m.name AS moderator_name
  FROM kudos k
  JOIN users s ON s.id = k.sender_id
  JOIN users r ON r.id = k.recipient_id
  LEFT JOIN users m ON m.id = k.moderated_by`;

function parseLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, 50);
}

function createApp(db, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const app = express();
  const auth = authMiddleware(db, cfg.jwtSecret);
  const usersCache = { value: null, at: 0 };
  const invalidateUsers = () => { usersCache.value = null; };

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestLogger(cfg.logger));
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  app.use(originCheck);

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  // ---------- Auth ----------
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: cfg.loginMaxAttempts,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many login attempts. Try again later.')),
  });

  app.post('/api/auth/login', loginLimiter, (req, res, next) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      cfg.logger.warn({ msg: 'failed_login', email });
      return next(new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password'));
    }
    const token = jwt.sign({ sub: user.id }, cfg.jwtSecret, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, maxAge: 8 * 60 * 60 * 1000 });
    res.json({ id: user.id, name: user.name, role: user.role });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.status(204).end();
  });

  app.get('/api/auth/me', auth, (req, res) => {
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role });
  });

  // ---------- Users ----------
  app.get('/api/users', auth, (req, res) => {
    if (!usersCache.value || Date.now() - usersCache.at > 5 * 60 * 1000) {
      usersCache.value = db.prepare('SELECT id, name FROM users WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all();
      usersCache.at = Date.now();
    }
    res.json(usersCache.value.filter((u) => u.id !== req.user.id));
  });

  // ---------- Kudos ----------
  app.get('/api/kudos', auth, (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = parseInt(req.query.cursor, 10);
    const params = [];
    let where = 'WHERE k.is_visible = 1';
    if (Number.isInteger(cursor)) { where += ' AND k.id < ?'; params.push(cursor); }
    const rows = db.prepare(`${KUDOS_SELECT} ${where} ORDER BY k.id DESC LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => toKudosJson(r));
    res.set('Cache-Control', 'no-store');
    res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  });

  app.post('/api/kudos', auth, (req, res, next) => {
    const v = validateKudosInput(req.body);
    if (!v.ok) return next(new ApiError(400, 'VALIDATION_ERROR', 'Please fix the highlighted fields', v.fields));
    if (v.recipientId === req.user.id) {
      return next(new ApiError(400, 'VALIDATION_ERROR', 'You cannot give kudos to yourself', { recipientId: 'You cannot give kudos to yourself' }));
    }
    const recipient = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(v.recipientId);
    if (!recipient) return next(new ApiError(400, 'VALIDATION_ERROR', 'That colleague does not exist', { recipientId: 'Please select a valid colleague' }));
    if (containsBlockedWord(v.message)) {
      return next(new ApiError(422, 'CONTENT_REJECTED', 'Your message contains inappropriate language', { message: 'Please keep it professional' }));
    }

    const count = (sql, ...p) => db.prepare(sql).get(...p).c;
    const minute = count(`SELECT COUNT(*) c FROM kudos WHERE sender_id=? AND created_at > datetime('now','-1 minute')`, req.user.id);
    const hour = count(`SELECT COUNT(*) c FROM kudos WHERE sender_id=? AND created_at > datetime('now','-1 hour')`, req.user.id);
    if (minute >= cfg.perMinuteLimit || hour >= cfg.perHourLimit) {
      res.set('Retry-After', minute >= cfg.perMinuteLimit ? '60' : '3600');
      return next(new ApiError(429, 'RATE_LIMITED', 'You are sending kudos too quickly. Please wait a bit.'));
    }
    const hash = hashMessage(v.message);
    const dupe = count(
      `SELECT COUNT(*) c FROM kudos WHERE sender_id=? AND recipient_id=? AND message_hash=? AND created_at > datetime('now','-1 day')`,
      req.user.id, v.recipientId, hash);
    if (dupe > 0) return next(new ApiError(409, 'DUPLICATE', 'You already sent this exact message to this colleague today'));
    const perRecipient = count(
      `SELECT COUNT(*) c FROM kudos WHERE sender_id=? AND recipient_id=? AND created_at > datetime('now','-1 day')`,
      req.user.id, v.recipientId);
    if (perRecipient >= cfg.perRecipientPerDay) {
      return next(new ApiError(429, 'RATE_LIMITED', 'You have reached the daily kudos limit for this colleague'));
    }

    const info = db.prepare('INSERT INTO kudos (sender_id, recipient_id, message, message_hash) VALUES (?,?,?,?)')
      .run(req.user.id, v.recipientId, v.message, hash);
    const row = db.prepare(`${KUDOS_SELECT} WHERE k.id = ?`).get(info.lastInsertRowid);
    res.status(201).json(toKudosJson(row));
  });

  app.post('/api/kudos/:id/report', auth, (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const kudos = db.prepare('SELECT * FROM kudos WHERE id = ?').get(id);
    if (!kudos || !kudos.is_visible) return next(new ApiError(404, 'NOT_FOUND', 'Kudos not found'));
    if (kudos.sender_id === req.user.id) return next(new ApiError(400, 'VALIDATION_ERROR', 'You cannot report your own kudos'));
    const r = validateReason(req.body?.reason, { required: false });
    if (!r.ok) return next(new ApiError(400, 'VALIDATION_ERROR', r.error, { reason: r.error }));

    const tx = db.transaction(() => {
      try {
        db.prepare('INSERT INTO kudos_reports (kudos_id, reporter_id, reason) VALUES (?,?,?)').run(id, req.user.id, r.reason);
      } catch (e) {
        if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new ApiError(409, 'DUPLICATE', 'You already reported this kudos');
        throw e;
      }
      db.prepare('UPDATE kudos SET report_count = report_count + 1 WHERE id = ?').run(id);
      const { report_count } = db.prepare('SELECT report_count FROM kudos WHERE id = ?').get(id);
      if (report_count >= cfg.autoHideThreshold) {
        db.prepare(`UPDATE kudos SET is_visible = 0, moderated_at = CURRENT_TIMESTAMP, moderation_reason = 'Auto-hidden: reached report threshold' WHERE id = ?`).run(id);
        db.prepare(`INSERT INTO moderation_log (kudos_id, admin_id, action, reason, message_snapshot) VALUES (?, NULL, 'auto_hide', 'Reached report threshold', ?)`).run(id, kudos.message);
      }
    });
    try { tx(); } catch (e) { return next(e); }
    res.status(204).end();
  });

  // ---------- Admin / moderation ----------
  const admin = express.Router();
  admin.use(auth, requireAdmin);

  admin.get('/kudos', (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = parseInt(req.query.cursor, 10);
    const status = ['all', 'visible', 'hidden', 'reported'].includes(req.query.status) ? req.query.status : 'all';
    const conds = [];
    const params = [];
    if (status === 'visible') conds.push('k.is_visible = 1');
    if (status === 'hidden') conds.push('k.is_visible = 0');
    if (status === 'reported') conds.push('k.report_count > 0');
    if (Number.isInteger(cursor)) { conds.push('k.id < ?'); params.push(cursor); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(`${KUDOS_SELECT} ${where} ORDER BY k.id DESC LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => toKudosJson(r, { admin: true }));
    res.set('Cache-Control', 'no-store');
    res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  });

  const findKudos = (id) => db.prepare('SELECT * FROM kudos WHERE id = ?').get(id);

  admin.patch('/kudos/:id/hide', (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const k = findKudos(id);
    if (!k) return next(new ApiError(404, 'NOT_FOUND', 'Kudos not found'));
    const r = validateReason(req.body?.reason, { required: true });
    if (!r.ok) return next(new ApiError(400, 'VALIDATION_ERROR', r.error, { reason: r.error }));
    db.transaction(() => {
      db.prepare('UPDATE kudos SET is_visible = 0, moderated_by = ?, moderated_at = CURRENT_TIMESTAMP, moderation_reason = ? WHERE id = ?').run(req.user.id, r.reason, id);
      db.prepare(`INSERT INTO moderation_log (kudos_id, admin_id, action, reason, message_snapshot) VALUES (?,?, 'hide', ?, ?)`).run(id, req.user.id, r.reason, k.message);
    })();
    res.json(toKudosJson(db.prepare(`${KUDOS_SELECT} WHERE k.id = ?`).get(id), { admin: true }));
  });

  admin.patch('/kudos/:id/restore', (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const k = findKudos(id);
    if (!k) return next(new ApiError(404, 'NOT_FOUND', 'Kudos not found'));
    db.transaction(() => {
      db.prepare('UPDATE kudos SET is_visible = 1, moderated_by = NULL, moderated_at = NULL, moderation_reason = NULL, report_count = 0 WHERE id = ?').run(id);
      db.prepare('DELETE FROM kudos_reports WHERE kudos_id = ?').run(id);
      db.prepare(`INSERT INTO moderation_log (kudos_id, admin_id, action, reason, message_snapshot) VALUES (?,?, 'restore', NULL, ?)`).run(id, req.user.id, k.message);
    })();
    res.json(toKudosJson(db.prepare(`${KUDOS_SELECT} WHERE k.id = ?`).get(id), { admin: true }));
  });

  admin.delete('/kudos/:id', (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const k = findKudos(id);
    if (!k) return next(new ApiError(404, 'NOT_FOUND', 'Kudos not found'));
    const r = validateReason(req.body?.reason, { required: true });
    if (!r.ok) return next(new ApiError(400, 'VALIDATION_ERROR', r.error, { reason: r.error }));
    db.transaction(() => {
      db.prepare(`INSERT INTO moderation_log (kudos_id, admin_id, action, reason, message_snapshot) VALUES (?,?, 'delete', ?, ?)`).run(id, req.user.id, r.reason, k.message);
      db.prepare('DELETE FROM kudos WHERE id = ?').run(id);
    })();
    res.status(204).end();
  });

  admin.get('/moderation-log', (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = parseInt(req.query.cursor, 10);
    const params = [];
    let where = '';
    if (Number.isInteger(cursor)) { where = 'WHERE l.id < ?'; params.push(cursor); }
    const rows = db.prepare(`SELECT l.*, u.name AS admin_name FROM moderation_log l LEFT JOIN users u ON u.id = l.admin_id ${where} ORDER BY l.id DESC LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((l) => ({
      id: l.id, kudosId: l.kudos_id, action: l.action, reason: l.reason, admin: l.admin_name || 'system',
      messageSnapshot: l.message_snapshot, createdAt: l.created_at.replace(' ', 'T') + 'Z',
    }));
    res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  });

  app.use('/api/admin', admin);

  // ---------- Static frontend ----------
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found')));
  app.use(errorHandler(cfg.logger));
  return app;
}

module.exports = { createApp };
