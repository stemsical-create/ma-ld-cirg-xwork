const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', err => console.error('[DB] Pool error:', err.message));
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('Database not configured');
  const client = await p.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initDatabase() {
  console.log('[DB] Initializing tables...');
  await query(`
    CREATE TABLE IF NOT EXISTS autorole_config (
      guild_id VARCHAR(255) PRIMARY KEY,
      enabled BOOLEAN DEFAULT false,
      log_channel VARCHAR(255),
      last_checked TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS autorole_mappings (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) NOT NULL,
      team_name VARCHAR(100) NOT NULL,
      role_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(guild_id, team_name)
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS autorole_players (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      roblox_id VARCHAR(255),
      team_name VARCHAR(100),
      verified BOOLEAN DEFAULT false,
      last_updated TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(guild_id, user_id)
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS autorole_access (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(255) NOT NULL,
      role_id VARCHAR(255) NOT NULL,
      permission VARCHAR(50) NOT NULL DEFAULT 'manage',
      UNIQUE(guild_id, role_id, permission)
    );
  `);
  console.log('[DB] Tables initialized');
}

module.exports = { getPool, query, initDatabase };
