#!/usr/bin/env node
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { DB_PATH, ensureSchema } = require('./lib/db');

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await ensureSchema(db);
  await db.close();
  console.log(`SQLite DB ready: ${DB_PATH}`);
})().catch(err => {
  console.error('init-db failed:', err);
  process.exit(1);
});
