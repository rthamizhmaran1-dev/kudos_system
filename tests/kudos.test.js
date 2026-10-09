const request = require('supertest');
const { createDb, seed } = require('../src/db');
const { createApp } = require('../src/app');

const silent = { info() {}, warn() {}, error() {} };

function setup(opts = {}) {
  const db = createDb(':memory:');
  seed(db);
  const app = createApp(db, { logger: silent, perMinuteLimit: 1000, perHourLimit: 1000, perRecipientPerDay: 1000, loginMaxAttempts: 1000, ...opts });
  return { db, app };
}

async function login(app, email, password = 'User123!') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

const userId = (db, email) => db.prepare('SELECT id FROM users WHERE email=?').get(email).id;

describe('authentication & authorization', () => {
  test('unauthenticated requests get 401', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/kudos')).status).toBe(401);
    expect((await request(app).get('/api/users')).status).toBe(401);
    expect((await request(app).post('/api/kudos').send({})).status).toBe(401);
  });

  test('bad credentials get 401', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/auth/login').send({ email: 'aroha@example.com', password: 'nope' });
    expect(res.status).toBe(401);
  });

  test('login sets an HttpOnly SameSite=Strict cookie', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/auth/login').send({ email: 'aroha@example.com', password: 'User123!' });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  test('normal users get 403 on admin routes', async () => {
    const { app } = setup();
    const agent = await login(app, 'aroha@example.com');
    expect((await agent.get('/api/admin/kudos')).status).toBe(403);
    expect((await agent.patch('/api/admin/kudos/1/hide').send({ reason: 'x' })).status).toBe(403);
    expect((await agent.delete('/api/admin/kudos/1').send({ reason: 'x' })).status).toBe(403);
  });

  test('cross-origin POST is blocked', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a', password: 'b' });
    expect(res.status).toBe(403);
  });
});

describe('users list', () => {
  test('excludes the current user and is sorted', async () => {
    const { app } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.find((u) => u.name === 'Aroha Kingi')).toBeUndefined();
    const names = res.body.map((u) => u.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('creating kudos', () => {
  test('valid kudos is created and appears in feed', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'sam@example.com'), message: '  Great work on the release!  ' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Great work on the release!');
    expect(res.body.sender.name).toBe('Aroha Kingi');
    const feed = await agent.get('/api/kudos');
    expect(feed.body.items).toHaveLength(1);
  });

  test.each([
    ['empty message', { message: '' }],
    ['whitespace only', { message: '    ' }],
    ['missing message', {}],
    ['501 characters', { message: 'a'.repeat(501) }],
  ])('rejects %s', async (_n, body) => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'sam@example.com'), ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.message).toBeDefined();
  });

  test('accepts exactly 500 characters', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'sam@example.com'), message: 'a'.repeat(500) });
    expect(res.status).toBe(201);
  });

  test('rejects missing / invalid / unknown recipient', async () => {
    const { app } = setup();
    const agent = await login(app, 'aroha@example.com');
    expect((await agent.post('/api/kudos').send({ message: 'hi' })).status).toBe(400);
    expect((await agent.post('/api/kudos').send({ recipientId: 'abc', message: 'hi' })).status).toBe(400);
    expect((await agent.post('/api/kudos').send({ recipientId: 9999, message: 'hi' })).status).toBe(400);
  });

  test('rejects kudos to yourself', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'aroha@example.com'), message: 'I am great' });
    expect(res.status).toBe(400);
  });

  test('rejects inappropriate language with 422', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'sam@example.com'), message: 'you are a bastard' });
    expect(res.status).toBe(422);
  });

  test('duplicate message to same colleague returns 409 (case/space-insensitive)', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const rid = userId(db, 'sam@example.com');
    expect((await agent.post('/api/kudos').send({ recipientId: rid, message: 'Thanks a lot' })).status).toBe(201);
    expect((await agent.post('/api/kudos').send({ recipientId: rid, message: '  thanks   A LOT ' })).status).toBe(409);
    // different recipient is fine
    expect((await agent.post('/api/kudos').send({ recipientId: userId(db, 'mei@example.com'), message: 'Thanks a lot' })).status).toBe(201);
  });

  test('per-minute rate limit returns 429 with Retry-After', async () => {
    const { app, db } = setup({ perMinuteLimit: 3 });
    const agent = await login(app, 'aroha@example.com');
    const rid = userId(db, 'sam@example.com');
    for (let i = 0; i < 3; i++) {
      expect((await agent.post('/api/kudos').send({ recipientId: rid, message: `Thanks number ${i}` })).status).toBe(201);
    }
    const res = await agent.post('/api/kudos').send({ recipientId: rid, message: 'Thanks number 4' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('daily limit per recipient returns 429', async () => {
    const { app, db } = setup({ perRecipientPerDay: 2 });
    const agent = await login(app, 'aroha@example.com');
    const rid = userId(db, 'sam@example.com');
    await agent.post('/api/kudos').send({ recipientId: rid, message: 'one' });
    await agent.post('/api/kudos').send({ recipientId: rid, message: 'two' });
    expect((await agent.post('/api/kudos').send({ recipientId: rid, message: 'three' })).status).toBe(429);
  });

  test('HTML/script is stored as inert plain text', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const payload = '<script>alert(1)</script>';
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'sam@example.com'), message: payload });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe(payload); // returned as data; frontend renders with textContent
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('SQL injection strings are handled safely', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const res = await agent.post('/api/kudos').send({ recipientId: userId(db, 'sam@example.com'), message: "x'); DROP TABLE kudos;--" });
    expect(res.status).toBe(201);
    expect((await agent.get('/api/kudos')).body.items).toHaveLength(1);
  });
});

describe('feed pagination', () => {
  test('cursor pagination returns newest first with nextCursor', async () => {
    const { app, db } = setup();
    const agent = await login(app, 'aroha@example.com');
    const rid = userId(db, 'sam@example.com');
    for (let i = 1; i <= 5; i++) await agent.post('/api/kudos').send({ recipientId: rid, message: `msg ${i}` });
    const p1 = await agent.get('/api/kudos?limit=2');
    expect(p1.body.items.map((k) => k.message)).toEqual(['msg 5', 'msg 4']);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await agent.get(`/api/kudos?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((k) => k.message)).toEqual(['msg 3', 'msg 2']);
    const p3 = await agent.get(`/api/kudos?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p3.body.items.map((k) => k.message)).toEqual(['msg 1']);
    expect(p3.body.nextCursor).toBeNull();
  });
});

describe('moderation', () => {
  async function withKudos() {
    const ctx = setup();
    const user = await login(ctx.app, 'aroha@example.com');
    const admin = await login(ctx.app, 'admin@example.com', 'Admin123!');
    const created = await user.post('/api/kudos').send({ recipientId: userId(ctx.db, 'sam@example.com'), message: 'Nice job' });
    return { ...ctx, user, admin, id: created.body.id };
  }

  test('hide requires a reason, then removes kudos from feed and records audit fields', async () => {
    const { admin, user, id, db } = await withKudos();
    expect((await admin.patch(`/api/admin/kudos/${id}/hide`).send({})).status).toBe(400);
    const res = await admin.patch(`/api/admin/kudos/${id}/hide`).send({ reason: 'Off topic' });
    expect(res.status).toBe(200);
    expect(res.body.isVisible).toBe(false);
    expect(res.body.moderatedBy).toBe('Alex Admin');
    expect(res.body.moderationReason).toBe('Off topic');
    expect((await user.get('/api/kudos')).body.items).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM moderation_log WHERE action=?').get('hide').c).toBe(1);
  });

  test('admin list can filter hidden items; restore brings it back and clears fields', async () => {
    const { admin, user, id } = await withKudos();
    await admin.patch(`/api/admin/kudos/${id}/hide`).send({ reason: 'Spam' });
    expect((await admin.get('/api/admin/kudos?status=hidden')).body.items).toHaveLength(1);
    expect((await admin.get('/api/admin/kudos?status=visible')).body.items).toHaveLength(0);
    const res = await admin.patch(`/api/admin/kudos/${id}/restore`);
    expect(res.body.isVisible).toBe(true);
    expect(res.body.moderatedBy).toBeNull();
    expect((await user.get('/api/kudos')).body.items).toHaveLength(1);
  });

  test('delete removes the row but keeps an audit log with snapshot', async () => {
    const { admin, id, db } = await withKudos();
    expect((await admin.delete(`/api/admin/kudos/${id}`).send({})).status).toBe(400);
    expect((await admin.delete(`/api/admin/kudos/${id}`).send({ reason: 'Inappropriate' })).status).toBe(204);
    expect(db.prepare('SELECT * FROM kudos WHERE id=?').get(id)).toBeUndefined();
    const log = (await admin.get('/api/admin/moderation-log')).body.items;
    expect(log[0]).toMatchObject({ action: 'delete', messageSnapshot: 'Nice job', admin: 'Alex Admin' });
  });

  test('hide/delete on missing kudos returns 404', async () => {
    const { admin } = await withKudos();
    expect((await admin.patch('/api/admin/kudos/9999/hide').send({ reason: 'x' })).status).toBe(404);
    expect((await admin.delete('/api/admin/kudos/9999').send({ reason: 'x' })).status).toBe(404);
  });

  test('reporting: once per user, not own kudos, flagged in admin view', async () => {
    const { app, admin, user, id } = await withKudos();
    expect((await user.post(`/api/kudos/${id}/report`).send({})).status).toBe(400); // own kudos
    const mei = await login(app, 'mei@example.com');
    expect((await mei.post(`/api/kudos/${id}/report`).send({ reason: 'Weird' })).status).toBe(204);
    expect((await mei.post(`/api/kudos/${id}/report`).send({})).status).toBe(409);
    const reported = (await admin.get('/api/admin/kudos?status=reported')).body.items;
    expect(reported).toHaveLength(1);
    expect(reported[0].reportCount).toBe(1);
    expect(reported[0].isVisible).toBe(true); // stays visible until threshold
  });

  test('auto-hides at the report threshold', async () => {
    const { app, user, id, db } = await withKudos();
    for (const email of ['mei@example.com', 'liam@example.com', 'priya@example.com']) {
      const a = await login(app, email);
      expect((await a.post(`/api/kudos/${id}/report`).send({})).status).toBe(204);
    }
    expect((await user.get('/api/kudos')).body.items).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM moderation_log WHERE action=?').get('auto_hide').c).toBe(1);
  });
});
