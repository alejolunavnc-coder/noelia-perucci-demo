# GYM — Preparación Mercado Pago OAuth (21/11/2026)
Referencia revisada: CJ Refrigeración, módulo `mercadopago-oauth.ts`. Esta preparación **NO habilita cobros**.

## Archivos
- `worker/mercadopago-oauth.js`: lógica preparada para vinculación del vendedor OAuth + PKCE S256, state único de 10 minutos, tokens cifrados AES-GCM, refresh y prevención de cambio de vendedor.
- `docs/sql/mercadopago_oauth_preparacion.sql`: DDL separado, **no aplicado** a D1.
- Aún no se añaden rutas públicas ni botones; no se puede usar OAuth con el dominio sin configurar.

## Antes de activar
1. Conectar y verificar `https://peruccinoelia.ar` en Cloudflare; decidir URL canónica.
2. Registrar app Mercado Pago Developers con OAuth + Checkout Pro y callback exacto `https://peruccinoelia.ar/api/mp/oauth/callback`.
3. Crear secretos del Worker: `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_TOKEN_ENCRYPTION_KEY` (32 bytes base64url), `MP_OAUTH_REDIRECT_URI` (callback exacto). No incluir en GitHub.
4. Respaldar D1, revisar migraciones y aplicar solo SQL necesario.
5. Conectar rutas protegidas admin status/start/disconnect; callback público; construir sección Pagos con botón Vincular.
6. Integrar preferencias de pago, webhook firmado, verificación servidor a servidor, idempotencia y autorización de descarga PDF ligada a orden `approved`.
7. **CRÍTICO:** actualmente `/api/checkout/complete` y `/api/checkout/download` permiten descargas sin pago; deshabilitar este flujo antes de comenzar a cobrar.
8. Probar cuentas de Mercado Pago de prueba; ninguna transacción real sin consentimiento.

## Límites
- No se modifican Cloudflare, D1 remoto, Cloudinary, precios, PDFs ni el dominio.
- No vincular una cuenta ajena, ni ejecutar una compra.
- La implementación en código debe probarse en ambiente aislado antes de activar endpoints.
