# Kudos System Specification

**Project:** Internal Employee Portal – Kudos Feature
**Author:** Graduate Developer / AI Architect, Datacom
**Status:** Approved for implementation
**Version:** 1.0
**GitHub Repository:** https://github.com/rthamizhmaran1-dev/kudos_system

## 1. Overview

The Kudos feature lets employees publicly recognise colleagues. A user picks a colleague, writes a short message of appreciation, and submits it. All recently submitted kudos appear in a public feed on the main dashboard. Administrators can moderate (hide, restore or delete) inappropriate kudos.

**Original request:** *"Create a feature for our internal web app that allows users to give 'kudos' to their colleagues. A user should be able to select another user from a list, write a short message of appreciation, and submit it. There should also be a public feed on the main dashboard where all recently submitted kudos are visible."*

**Architect additions (not in the original request):** content moderation, duplicate/spam protection, authentication and authorization, input sanitisation, pagination, and audit fields.

### Assumptions
- The portal is internal, so every user is an authenticated employee. "Public feed" means visible to all authenticated employees, not the open internet.
- A user cannot give kudos to themselves.
- Kudos are immutable once submitted. Users cannot edit them, and only admins can hide or delete.
- Proposed stack (swappable): Node.js + Express, SQLite (via `better-sqlite3`), vanilla HTML/CSS/JS frontend, JWT auth in an HTTP-only cookie.

---

## 2. Functional Requirements

### 2.1 User Stories

| ID | Story |
|----|-------|
| US-1 | As a user, I can log in so that my kudos are attributed to me. |
| US-2 | As a user, I can select another user from a searchable dropdown list of colleagues. |
| US-3 | As a user, I can write a message of appreciation (1–500 characters). |
| US-4 | As a user, I can submit the kudos, which is stored in the database. |
| US-5 | As a user, I can view a feed of recent kudos on the dashboard, newest first. |
| US-6 | As a user, I see clear validation and error messages when something is wrong. |
| US-7 | As a user, I can use the feature on desktop, tablet and mobile. |
| **US-8** | **As an administrator, I can hide a kudos message so it no longer appears in the public feed.** |
| **US-9** | **As an administrator, I can restore a previously hidden kudos message.** |
| **US-10** | **As an administrator, I can permanently delete a kudos message.** |
| **US-11** | **As an administrator, I can see a moderation view of all kudos (including hidden), with who moderated them, when, and why.** |
| **US-12** | **As a user, I can report a kudos as inappropriate so an admin can review it.** |
| **US-13** | **As the system, I prevent spam and duplicate submissions.** |

### 2.2 Acceptance Criteria

**US-1 Authentication**
- Unauthenticated requests to any kudos endpoint return `401`.
- Login with valid credentials sets a signed, HTTP-only, `SameSite=Strict` session cookie.
- Roles: `user` and `admin`. Role is read from the database and never trusted from client input.

**US-2 Select colleague**
- The dropdown lists all active users except the current user, sorted alphabetically.
- The list is searchable by typing (client-side filter).
- Submitting without a recipient shows "Please select a colleague".

**US-3 / US-4 Write and submit**
- Message is trimmed and must be 1–500 characters (server-enforced; the client shows a live counter).
- Whitespace-only messages are rejected.
- On success the form clears, a confirmation toast shows, and the new kudos appears at the top of the feed without a full page reload.
- The recipient must exist and be active. The sender cannot equal the recipient (`400`).

**US-5 Feed**
- Shows only kudos where `is_visible = true`, newest first.
- Each item shows sender name, recipient name, message and relative timestamp ("5 minutes ago").
- Paginated: 20 items per page with a "Load more" control (cursor-based).
- Empty state: "No kudos yet – be the first!"

**US-6 Validation and errors**
- Field-level errors are shown inline; server errors show a friendly banner with no stack traces.
- Network failure shows "Couldn't submit kudos. Please try again." and preserves the user's typed message.

**US-7 Responsive**
- Layout works from 320px upward. Form and feed stack vertically on mobile; two columns on screens ≥ 900px.
- All controls are keyboard accessible and labelled (WCAG AA colour contrast).

**US-8 Hide**
- Only admins see "Hide" controls; non-admin API calls return `403`.
- Hiding sets `is_visible = false` and records `moderated_by`, `moderated_at` and `moderation_reason` (reason required, max 255 characters).
- A hidden kudos disappears from the public feed for all non-admin users immediately on next fetch.

**US-9 Restore**
- Admin can set `is_visible = true`. Moderation fields are cleared, and the restore action is written to the moderation log.

**US-10 Delete**
- Admin can permanently delete (hard delete) after a confirmation dialog.
- A record of the deletion (kudos id, admin, reason, timestamp) is retained in `moderation_log`.

**US-11 Moderation view**
- Admin-only page lists all kudos with filters: All / Visible / Hidden / Reported.
- Shows moderator, timestamp and reason for hidden items, plus report count.

**US-12 Report**
- A user can report a kudos once (unique per user + kudos) with an optional reason.
- A user cannot report their own kudos.
- Reported kudos remain visible until an admin acts, but are flagged in the moderation view. They auto-hide at ≥ 3 distinct reports (configurable) pending admin review.

**US-13 Spam and duplicates**
- Rate limit: max 10 kudos per user per hour and 3 per minute (`429` with `Retry-After`).
- Duplicate: the same sender cannot send an identical message (case-insensitive, trimmed) to the same recipient within 24 hours (`409`).
- A max of 5 kudos from one sender to the same recipient per day.
- A basic profanity/blocked-words filter rejects or flags messages (`422` with a generic "message contains inappropriate language").
- The submit button is disabled while the request is in flight, to prevent double-clicks.

### 2.3 Edge Cases Considered

| Case | Behaviour |
|------|-----------|
| Self-kudos | Rejected (`400`). |
| Recipient deactivated or deleted after kudos sent | Kudos kept; the recipient name shows from stored data and "(former employee)" is appended. |
| HTML or script injection in the message | Stored as plain text, escaped on output; never rendered as HTML. |
| Emoji / Unicode | Allowed; length counted in characters, not bytes. |
| Very long unbroken strings | Truncated by validation and wrapped via CSS `overflow-wrap: anywhere`. |
| Concurrent hide and delete | Delete wins; hide on a missing record returns `404`. |
| Admin hides own kudos | Allowed. |
| Feed during moderation | Hidden items drop out on next fetch; the feed polls every 60 seconds. |
| Clock skew | All timestamps set server-side in UTC. |

---

## 3. Technical Design

### 3.1 Architecture

```
Browser (HTML/CSS/JS)  ──HTTPS──▶  Express API  ──▶  SQLite
        ▲                              │
        └──── JSON responses ◀─────────┘
                       Middleware: auth, RBAC, rate-limit, validation, logging
```

### 3.2 Database Schema

**`users`**

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK, autoincrement |
| name | TEXT | NOT NULL |
| email | TEXT | NOT NULL, UNIQUE |
| password_hash | TEXT | NOT NULL (bcrypt) |
| role | TEXT | NOT NULL, default `'user'`, CHECK in (`user`,`admin`) |
| is_active | BOOLEAN | NOT NULL, default `1` |
| created_at | DATETIME | NOT NULL, default CURRENT_TIMESTAMP |

**`kudos`**

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK, autoincrement |
| sender_id | INTEGER | NOT NULL, FK → users.id |
| recipient_id | INTEGER | NOT NULL, FK → users.id, CHECK (recipient_id <> sender_id) |
| message | TEXT | NOT NULL, CHECK (length 1–500) |
| message_hash | TEXT | NOT NULL (SHA-256 of normalised message; used for duplicate detection) |
| **is_visible** | **BOOLEAN** | **NOT NULL, default `1` (true)** |
| **moderated_by** | **INTEGER** | **NULL, FK → users.id (admin who hid it)** |
| **moderated_at** | **DATETIME** | **NULL** |
| **moderation_reason** | **TEXT** | **NULL, max 255 chars** |
| report_count | INTEGER | NOT NULL, default `0` |
| created_at | DATETIME | NOT NULL, default CURRENT_TIMESTAMP |

Indexes:
- `idx_kudos_feed` on `(is_visible, created_at DESC)`, for feed queries
- `idx_kudos_sender_created` on `(sender_id, created_at)`, for rate limiting
- `idx_kudos_dupe` on `(sender_id, recipient_id, message_hash, created_at)`, for duplicate detection

**`kudos_reports`**

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| kudos_id | INTEGER | NOT NULL, FK → kudos.id ON DELETE CASCADE |
| reporter_id | INTEGER | NOT NULL, FK → users.id |
| reason | TEXT | NULL, max 255 |
| created_at | DATETIME | NOT NULL, default CURRENT_TIMESTAMP |
| | | UNIQUE (kudos_id, reporter_id) |

**`moderation_log`** (audit trail, survives hard deletes)

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| kudos_id | INTEGER | NOT NULL (no FK, so the record persists after deletion) |
| admin_id | INTEGER | NULL, FK → users.id (NULL when the action was an automatic `auto_hide`) |
| action | TEXT | NOT NULL, CHECK in (`hide`,`restore`,`delete`,`auto_hide`) |
| reason | TEXT | NULL |
| message_snapshot | TEXT | NOT NULL (copy of the message at action time) |
| created_at | DATETIME | NOT NULL, default CURRENT_TIMESTAMP |

**Relationships:** `users 1—N kudos` (as sender), `users 1—N kudos` (as recipient), `users 1—N kudos` (as moderator), `kudos 1—N kudos_reports`, `users 1—N moderation_log`.

### 3.3 API Endpoints

All endpoints are under `/api`, return JSON, and require authentication unless noted.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | public | Body `{email, password}` → sets cookie; `200` / `401` |
| POST | `/auth/logout` | user | Clears cookie |
| GET | `/auth/me` | user | Current user `{id, name, role}` |
| GET | `/users` | user | List active colleagues (excluding self) `[{id, name}]` |
| GET | `/kudos?limit=20&cursor=<id>` | user | Visible kudos, newest first → `{items, nextCursor}` |
| POST | `/kudos` | user | Body `{recipientId, message}` → `201` created kudos. Errors: `400`, `409` duplicate, `422` content, `429` rate limit |
| POST | `/kudos/:id/report` | user | Body `{reason?}` → `204`; `409` if already reported |
| GET | `/admin/kudos?status=all\|visible\|hidden\|reported&cursor=` | admin | Full list incl. moderation fields |
| PATCH | `/admin/kudos/:id/hide` | admin | Body `{reason}` (required) → `200` |
| PATCH | `/admin/kudos/:id/restore` | admin | → `200` |
| DELETE | `/admin/kudos/:id` | admin | Body `{reason}` → `204` |
| GET | `/admin/moderation-log` | admin | Paginated audit log |

**Standard error format:**
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Message must be 1–500 characters", "fields": { "message": "Too long" } } }
```

**Example `POST /api/kudos`**
```json
// Request
{ "recipientId": 7, "message": "Thanks for staying late to fix the release!" }
// 201 Response
{ "id": 42, "sender": {"id": 3, "name": "Aroha K."}, "recipient": {"id": 7, "name": "Sam L."},
  "message": "Thanks for staying late to fix the release!", "createdAt": "2026-10-09T03:15:00Z" }
```

### 3.4 Frontend Components

```
App
├── LoginPage
└── DashboardPage
    ├── Header (user name, logout, admin link if admin)
    ├── KudosForm
    │   ├── RecipientSelect (searchable dropdown)
    │   ├── MessageInput (textarea + live 0/500 counter)
    │   └── SubmitButton (disabled while loading)
    ├── KudosFeed
    │   ├── KudosCard (sender → recipient, message, time, Report button)
    │   └── LoadMoreButton
    └── Toast / ErrorBanner
AdminModerationPage (admin only)
    ├── StatusFilterTabs (All / Visible / Hidden / Reported)
    ├── ModerationTable
    │   └── ModerationRow (Hide / Restore / Delete, reason modal)
    └── ConfirmDialog
```

**Interactions:**
- `KudosForm` submit → `POST /kudos` → on success, prepend the item to `KudosFeed` and show a toast; on error, show inline field errors.
- `KudosFeed` loads on mount, polls every 60s, and "Load more" calls the API with `cursor`.
- Moderation actions call the admin endpoints and optimistically update the row, rolling back on failure.

### 3.5 Security Considerations
- **Authentication:** bcrypt password hashing (cost ≥ 10); JWT in an HTTP-only, Secure, `SameSite=Strict` cookie; 8-hour expiry.
- **Authorization:** role-based middleware on all `/admin/*` routes; the sender is always taken from the session, never from the request body.
- **Input sanitisation:** server-side validation (type, length, trim); parameterised SQL only; output escaped (`textContent`, never `innerHTML`); message stored as plain text.
- **CSRF:** `SameSite=Strict` cookie plus an Origin header check on state-changing requests.
- **Headers:** `helmet` (CSP, X-Content-Type-Options, etc.).
- **Rate limiting:** per-user limits on kudos creation and reporting; per-IP limit on login (5 attempts / 15 min).
- **Privacy:** no stack traces or internal IDs in error output; moderation reasons are visible to admins only.

### 3.6 Performance Considerations
- Cursor-based pagination (20 per page) avoids deep OFFSET scans.
- Composite index `(is_visible, created_at DESC)` serves the feed query.
- `GET /users` response cached in memory for 5 minutes (invalidated on user change).
- `Cache-Control: no-store` on authenticated API responses; static assets cached with a long max-age.
- Feed polling interval of 60s, with backoff on errors.

### 3.7 Error Handling and Logging
- Central Express error handler maps known errors to the standard format and unknown errors to a generic `500`.
- Structured JSON logs (`pino`): request id, user id, route, status, latency.
- Security events are logged at `warn` (failed logins, `403`s, rate-limit hits).
- All moderation actions are written to `moderation_log` (audit) as well as application logs.
- Never log passwords, tokens or full message bodies at `info` level.

---

## 4. Implementation Plan

### 4.1 Task Breakdown and Dependencies

| # | Task | Depends on |
|---|------|-----------|
| 1 | Project scaffold: repo, `package.json`, folder structure, lint config, `.gitignore`, `.env.example` | – |
| 2 | Database module, schema migration and seed data (admin, 5+ sample users) | 1 |
| 3 | Auth: login/logout/me, password hashing, session middleware, RBAC middleware | 2 |
| 4 | `GET /users` endpoint | 3 |
| 5 | Validation + sanitisation layer; blocked-words filter | 1 |
| 6 | `POST /kudos` with duplicate, rate-limit and self-kudos checks | 3, 4, 5 |
| 7 | `GET /kudos` feed with cursor pagination (visible only) | 2, 3 |
| 8 | Admin moderation endpoints (list, hide, restore, delete) + `moderation_log` | 3, 7 |
| 9 | Reporting endpoint + auto-hide threshold | 6, 8 |
| 10 | Frontend: login page and dashboard shell | 3 |
| 11 | Frontend: `KudosForm` (recipient select, counter, validation, toasts) | 4, 6, 10 |
| 12 | Frontend: `KudosFeed` (cards, load more, polling, report button) | 7, 9, 10 |
| 13 | Frontend: Admin moderation page | 8, 10 |
| 14 | Responsive styling and accessibility pass | 11, 12, 13 |
| 15 | Automated tests (unit, API integration) | 6–9 |
| 16 | Documentation: `README.md` (setup, run, test), final `SPECIFICATION.md` | all |

### 4.2 Testing Strategy
- **Unit tests:** validation rules, duplicate-hash normalisation, rate-limit logic, blocked-words filter.
- **API integration tests** (Jest + Supertest, in-memory SQLite):
  - Unauthenticated access → `401`; non-admin on admin routes → `403`.
  - Create kudos: valid, empty, 501 characters, self-kudos, unknown recipient, duplicate (`409`), rate limit (`429`).
  - Feed returns only visible kudos; pagination cursor works; a hidden kudos disappears from the feed.
  - Hide → restore → delete flows write `moderation_log` entries.
  - Report uniqueness and auto-hide threshold.
- **Security tests:** XSS payload stored and returned as inert text; SQL injection strings are handled safely.
- **Manual/UI checks:** responsive layouts at 320px / 768px / 1280px, keyboard navigation, screen-reader labels.
- **Target:** ≥ 80% coverage of the service layer.

### 4.3 Deployment Considerations
- Configuration via environment variables (`PORT`, `JWT_SECRET`, `DB_PATH`, `RATE_LIMIT_*`, `AUTO_HIDE_THRESHOLD`); no secrets committed.
- Run behind HTTPS (reverse proxy or the portal's existing gateway); `Secure` cookies in production.
- Database migrations run at startup; the SQLite file is on a persistent volume with scheduled backups (migrate to PostgreSQL if scale requires; the schema is portable).
- Containerisable with a simple `Dockerfile`; health check endpoint `GET /healthz`.
- Integration path: replace the demo auth with the portal's SSO and user directory when available.

---

## 5. Out of Scope (v1)
Editing kudos, reactions/comments, email or Slack notifications, leaderboards, file attachments, and SSO integration.

## 6. Approval

| Role | Name | Decision |
|------|------|----------|
| Architect / Developer | _[YOUR NAME HERE]_ | ✅ Approved for implementation |
