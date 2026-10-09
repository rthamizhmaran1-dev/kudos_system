# Kudos System

An internal-portal feature that lets employees give public kudos to colleagues, with an admin moderation area.
Built with a **spec-driven development** process – see [`SPECIFICATION.md`](./SPECIFICATION.md) for the approved requirements, design and plan.

## Features
- Login (JWT in an HTTP-only cookie), `user` and `admin` roles
- Pick a colleague from a searchable list, write a message (1–500 chars), submit
- Public feed on the dashboard (newest first, cursor pagination, auto-refresh every 60s)
- Report button for users; auto-hide after 3 distinct reports
- Admin moderation page: hide (with reason), restore, permanently delete, filter by All / Visible / Hidden / Reported
- Spam protection: rate limits, duplicate detection, daily per-recipient limit, basic blocked-words filter
- Audit trail in `moderation_log` (survives deletes)
- Responsive, keyboard-accessible UI; user text is never rendered as HTML (XSS-safe)

## Tech stack
Node.js · Express · SQLite (`better-sqlite3`) · vanilla HTML/CSS/JS · Jest + Supertest

## Run it
Requires **Node.js 18+**.

```bash
npm install
npm start
```
Open http://localhost:3000

Demo accounts (created automatically on first run):

| Role  | Email                | Password   |
|-------|----------------------|------------|
| Admin | admin@example.com    | Admin123!  |
| User  | aroha@example.com    | User123!   |
| User  | sam@example.com      | User123!   |
| User  | mei@example.com      | User123!   |
| User  | liam@example.com     | User123!   |
| User  | priya@example.com    | User123!   |

Tip: open a second private/incognito window to be logged in as two different people at once.

## Run the tests
```bash
npm test
```

## Configuration
Copy `.env.example` to `.env` to override defaults (`PORT`, `JWT_SECRET`, `DB_PATH`, `AUTO_HIDE_THRESHOLD`).
In production (`NODE_ENV=production`) `JWT_SECRET` is required and cookies are marked `Secure`.

## API summary
| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login`, `/api/auth/logout` | public / user |
| GET | `/api/auth/me`, `/api/users` | user |
| GET / POST | `/api/kudos` | user |
| POST | `/api/kudos/:id/report` | user |
| GET | `/api/admin/kudos?status=all\|visible\|hidden\|reported` | admin |
| PATCH | `/api/admin/kudos/:id/hide`, `/restore` | admin |
| DELETE | `/api/admin/kudos/:id` | admin |
| GET | `/api/admin/moderation-log` | admin |

## Project structure
```
src/        backend (app, db, middleware, validation, server)
public/     frontend (index.html, admin.html, JS, CSS)
tests/      Jest + Supertest API tests
SPECIFICATION.md   approved requirements, design and plan
```
