-- GYM: esquema futuro de conexión Mercado Pago. No ejecutar sin backup D1.
CREATE TABLE IF NOT EXISTS gym_mp_oauth_attempts (
 state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gym_mp_connections (
 id INTEGER PRIMARY KEY CHECK(id=1), seller_id TEXT NOT NULL,
 secrets TEXT NOT NULL, expires_at INTEGER NOT NULL,
 connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gym_mp_payment_intents (
 id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, order_id TEXT,
 preference_id TEXT, payment_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('created','pending','in_process','approved','rejected','cancelled','refunded','charged_back')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS gym_mp_payment_intents_status ON gym_mp_payment_intents(status);
