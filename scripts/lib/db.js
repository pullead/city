'use strict';

const fs = require('fs');
const path = require('path');

function req(name) {
  return require(name);
}

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.CRAWLER_DB_PATH || path.join(ROOT, 'data', 'crawlers.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

async function hasColumn(db, table, column) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.some(row => row.name === column);
}

async function addColumn(db, table, column, definition) {
  if (!(await hasColumn(db, table, column))) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureSchema(db) {
  await db.run('PRAGMA busy_timeout=10000');

  await db.run(`
    CREATE TABLE IF NOT EXISTS girls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      age INTEGER,
      height INTEGER,
      bust TEXT,
      waist INTEGER,
      hip INTEGER,
      price_60 TEXT,
      price_90 TEXT,
      price_120 TEXT,
      course TEXT,
      foreigner_ok TEXT,
      paipan TEXT,
      options_list TEXT,
      basic_play TEXT,
      catchphrase TEXT,
      message TEXT,
      description TEXT,
      schedule TEXT,
      dto_url TEXT,
      cityheaven_url TEXT,
      shop TEXT,
      shops TEXT,
      gal_id INTEGER,
      sources TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      girl_name TEXT,
      gal_id INTEGER,
      reviewer TEXT,
      title TEXT,
      comment TEXT,
      rating_overall REAL,
      rating_looks REAL,
      rating_play REAL,
      rating_cost REAL,
      rating_photo REAL,
      rating_staff REAL,
      rating_service REAL,
      date TEXT,
      shop TEXT,
      shop_reply TEXT,
      source TEXT,
      source_url TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS bakusai_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      post_num INTEGER NOT NULL,
      shop TEXT,
      author TEXT DEFAULT '匿名さん',
      content TEXT NOT NULL,
      content_norm TEXT,
      quotes_json TEXT,
      posted_at TEXT,
      scraped_at TEXT,
      thread_url_canonical TEXT,
      thread_title TEXT,
      UNIQUE(thread_id, post_num)
    )
  `);

  await addColumn(db, 'girls', 'shops', 'TEXT');
  await addColumn(db, 'girls', 'cityheaven_url', 'TEXT');
  await addColumn(db, 'girls', 'created_at', 'TEXT DEFAULT CURRENT_TIMESTAMP');
  await addColumn(db, 'reviews', 'gal_id', 'INTEGER');
  await addColumn(db, 'reviews', 'rating_cost', 'REAL');
  await addColumn(db, 'reviews', 'rating_photo', 'REAL');
  await addColumn(db, 'reviews', 'rating_service', 'REAL');
  await addColumn(db, 'reviews', 'created_at', 'TEXT DEFAULT CURRENT_TIMESTAMP');
  await addColumn(db, 'bakusai_posts', 'content_norm', 'TEXT');
  await addColumn(db, 'bakusai_posts', 'thread_url_canonical', 'TEXT');
  await addColumn(db, 'bakusai_posts', 'thread_title', 'TEXT');

  await db.run('CREATE INDEX IF NOT EXISTS idx_girls_shop ON girls(shop)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_girls_gal_id ON girls(gal_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_reviews_source ON reviews(source)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_bakusai_thread ON bakusai_posts(thread_id)');
}

module.exports = {
  req,
  DB_PATH,
  ensureSchema,
};
