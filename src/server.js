const path = require('path');
const { createDb, seed } = require('./db');
const { createApp } = require('./app');

// Tiny .env loader (no extra dependency)
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
} catch { /* ignore */ }

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kudos.db');
const production = process.env.NODE_ENV === 'production';

if (production && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

const db = createDb(DB_PATH);
seed(db);

const app = createApp(db, {
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  autoHideThreshold: Number(process.env.AUTO_HIDE_THRESHOLD) || 3,
  secureCookies: production,
});

app.listen(PORT, () => {
  console.log(`Kudos app running at http://localhost:${PORT}`);
  console.log('Demo logins -> admin@example.com / Admin123!   |   aroha@example.com / User123!');
});
