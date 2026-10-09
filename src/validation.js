const crypto = require('crypto');

const MAX_LEN = 500;
const BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick'];

function normaliseMessage(msg) {
  return String(msg ?? '').replace(/\s+/g, ' ').trim();
}

function hashMessage(msg) {
  return crypto.createHash('sha256').update(normaliseMessage(msg).toLowerCase()).digest('hex');
}

function containsBlockedWord(msg) {
  const lower = msg.toLowerCase();
  return BLOCKED_WORDS.some((w) => new RegExp(`\\b${w}\\w*\\b`).test(lower));
}

// Counts characters (not bytes) so emoji are handled fairly.
function charLength(s) {
  return Array.from(s).length;
}

function validateKudosInput(body) {
  const fields = {};
  const recipientId = Number(body?.recipientId);
  if (!Number.isInteger(recipientId) || recipientId <= 0) fields.recipientId = 'Please select a colleague';
  const message = normaliseMessage(body?.message);
  if (typeof body?.message !== 'string' || message.length === 0) fields.message = 'Message is required';
  else if (charLength(message) > MAX_LEN) fields.message = `Message must be at most ${MAX_LEN} characters`;
  return { ok: Object.keys(fields).length === 0, fields, recipientId, message };
}

function validateReason(reason, { required }) {
  const r = String(reason ?? '').trim();
  if (required && !r) return { ok: false, error: 'A reason is required' };
  if (r.length > 255) return { ok: false, error: 'Reason must be at most 255 characters' };
  return { ok: true, reason: r || null };
}

module.exports = { MAX_LEN, normaliseMessage, hashMessage, containsBlockedWord, validateKudosInput, validateReason };
