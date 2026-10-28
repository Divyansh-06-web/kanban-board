# Kanban board for small teams

Projects with columns and cards. Members drag cards between columns (order saved on the server), comment on cards, and see an activity log. Cards move live in every open browser.

**Stack:** Node 22.13+ / Express, SQLite (Node's built-in `node:sqlite`, nothing to compile), Zod validation, JWT login, plain JavaScript frontend with SortableJS (mouse + touch). No build step.

## Run it

```bash
npm install
cp .env.example .env        # then set JWT_SECRET to a long random string
npm run seed                # creates ./data/kanban.db with demo data
npm start                   # http://localhost:3000
npm test                    # 14 automated tests
```

Requires **Node 22.13 or newer** (check with `node -v`). Node prints a one-line "SQLite is an experimental feature" warning; it is harmless.

### Demo logins (password for all: `password123`)

| Email | Role |
|---|---|
| asha@demo.com | owner of "Website Launch" (can manage members and columns) |
| ravi@demo.com | member of "Website Launch", owner of "Ravi private roadmap" |
| meera@demo.com | member of "Website Launch" only. Log in as her to confirm she never sees the private project. |
| sam@demo.com | not in any project. Invite him from Asha's board (Members, Invite). |

### Settings (`.env.example`)

`PORT`, `JWT_SECRET`, `DATABASE_PATH`. No secrets are committed; `.env` and `data/` are git-ignored.

## Data model

```
users(id, email unique, name, password_hash)
projects(id, name, owner_id)
memberships(project_id, user_id, role owner|member)   PK (project_id, user_id)
columns(id, project_id, name, position REAL)           index (project_id, position)
cards(id, project_id, column_id, title, description, assignee_id, due_date, position REAL)
                                                       index (column_id, position)
labels(id, project_id, name, color)   card_labels(card_id, label_id)
comments(id, card_id, project_id, author_id, body, created_at)
activity(id, project_id, actor_id, type, card_id, message, created_at)
```

## Main design decisions

**Card order uses fractional positions.** `position` is a REAL. Dropping a card between two neighbours stores the midpoint, at the top it stores `next - 1`, at the bottom `prev + 1`. A move therefore writes exactly one row (a test asserts this), and the order after a refresh is just `ORDER BY position`. The client sends the ids of the card above and below the drop point, never a number, so the server owns the maths (`src/positions.js`, `movePosition` in `src/app.js`). If repeated inserts squeeze two neighbours closer than 1e-6, that one column is renumbered 1..n inside the same transaction (a test forces this with 40 inserts into the same gap). Columns are ordered the same way.

**Authorization is checked on the server for every project-scoped request.** Routes keyed by card or column id load the row, read its `project_id`, then check membership (`loadCard`, `loadColumn`, `requireProject`). Non-members get **404, not 403**, so ids can't be probed. Owner-only actions (columns, members) return 403 for plain members. `project_id` is stored on cards and comments so this is one lookup. Assignees must be project members; a move target column must be in the card's project.

**Validation:** every body and query is parsed with Zod; errors come back as `{ error, errors: [{ field, message }] }` and the UI shows each message beside its input.

**Activity log:** a human-readable sentence is stored when the action happens (`Asha moved "Login page" from To do to In progress`). Storing the text means later renames don't rewrite history. Only cross-column moves are logged, not same-column reorders, to keep the log useful.

**Live updates:** Server-Sent Events, one channel per project. After any change the server sends a "changed" ping and open clients re-fetch the board. If you are mid-drag the refresh waits until you drop.

**Mobile:** columns scroll sideways with snap; on touch, cards need a short long-press to drag so normal scrolling still works; modals become bottom sheets and the activity panel fills the screen.

## What is finished

- Register / login, projects, invite existing users, remove members, owner and member roles
- Add / rename / reorder / delete (when empty) columns
- Cards with title, description, assignee, due date, labels; drag within and between columns, saved on the server
- Comments, per-project activity log
- Stretch: live updates (SSE) and filters by assignee, label, overdue
- 14 automated tests (position maths, rebalance, ordering, authorization, validation, activity, comments)

## What isn't, and what I'd do with more time

- Invites only work for people who already registered (no email invitations or invite links)
- No rate limiting on login, no password reset, no refresh tokens
- The SSE connection puts the JWT in the query string (browsers can't set headers on `EventSource`). I would switch to short-lived stream tickets or cookies.
- Deleting or leaving a project, editing or deleting comments, and card archiving are missing
- SQLite is perfect for a demo; for several server instances I would move to PostgreSQL (the SQL is plain) and replace the in-memory SSE hub with Redis pub/sub
- Frontend tests (Playwright) and a keyboard-accessible alternative to drag and drop ("Move to column" menu)
- Optimistic UI for moves (today the board re-fetches after a move)

## AI tools used

Claude was used to draft the first version of the code, tests and this README from the assignment text. I then read, ran and changed it. *(Edit this section so it describes what you actually did.)*
