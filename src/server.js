import 'dotenv/config';
import { openDb } from './db.js';
import { createApp } from './app.js';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me') {
  console.warn('WARNING: set a real JWT_SECRET in .env (see .env.example). Using an insecure dev secret.');
}
const db = openDb(process.env.DATABASE_PATH || './data/kanban.db');
const app = createApp({ db, jwtSecret: jwtSecret || 'insecure-dev-secret' });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Kanban running on http://localhost:${port}`));
