-- GYM 2026-11-25: pagos personalizados sin vinculación a PDF.
-- Aplicar una sola vez en D1; la columna no existía anteriormente.
ALTER TABLE orders ADD COLUMN product_type TEXT NOT NULL DEFAULT 'routine' CHECK(product_type IN ('routine','personalizado'));
-- Para los pedidos nuevos de personalizado se usa plan_id = NULL.
-- Los 12 planes estándar siguen apuntando a training_plans(id).
