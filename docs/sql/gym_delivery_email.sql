-- GYM / Noelia Perucci: correo transaccional y recuperación de rutinas, 2026-11-23.
-- Aplicado a D1 producción. Idempotente para reproducciones.
CREATE TABLE IF NOT EXISTS gym_delivery_emails (
  order_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX IF NOT EXISTS gym_delivery_emails_queue ON gym_delivery_emails(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS gym_delivery_links (
  token_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gym_delivery_links_order ON gym_delivery_links(order_id);
CREATE TABLE IF NOT EXISTS gym_recovery_requests (
  id TEXT PRIMARY KEY, email_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gym_recovery_requests_email ON gym_recovery_requests(email_hash,created_at);
CREATE INDEX IF NOT EXISTS gym_recovery_requests_ip ON gym_recovery_requests(ip_hash,created_at);
