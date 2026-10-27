# Noelia Perucci — Demo visual V4.2

Web de muestra publicada como **Cloudflare Workers Static Assets**, desde el repositorio de GitHub `alejolunavnc-coder/noelia-perucci-demo`.

## Estado actual

- **Inicio:** «Un día a la vez», «Resultados reales» (fotografías pendientes) y «Quién es BarbieMonstruo».
- **Entrenamientos:** asesoría integral online y planes personalizados.
- **Selector de rutinas:** principiante, intermedio o avanzado; 2, 3, 4 o 5 días por semana.
- **Precios de las rutinas:** 2 días $50.000 ARS; 3 días $60.000 ARS; 4 o 5 días $80.000 ARS.
- **Compra y descarga:** DEMOSTRACIÓN. No se procesa dinero real; el PDF es de muestra.
- **Control mensual:** opcional **al renovar el plan**. Guía para registro inicial y mensual; formulario que prepara el texto para copiar a un correo; Noelia respondería personalmente.
- **Privacidad:** esta web no recibe ni almacena fotos de progresos, y el formulario de control no envía ni almacena peso o medidas. Las fotos se adjuntarán desde el correo del alumno cuando el envío real esté habilitado.
- **Contacto:** prepara mensajes para copiar; envío real por correo o WhatsApp pendiente de configurar.
- **Sin:** cuentas de usuario, contraseñas ni panel de administración.

## Lo que falta para una tienda real

1. Integrar Mercado Pago con verificación del pago y entrega privada del PDF correcto.
2. Incorporar las 12 rutinas reales de Noelia.
3. Definir correo de Noelia y habilitar entrega y control mensual por email.
4. Verificar renovaciones mediante referencia de compra, antes de dar acceso al control.
5. Definir información de privacidad y conservación de datos en los correos.
6. Confirmar el precio del servicio personalizado y WhatsApp de destino.
7. Incorporar fotos reales de resultados con autorización de publicación.

**No presentar esta demo como una tienda que ya cobra o como un servicio de control que ya envía información.**

## Cloudflare Workers

Configuración en `wrangler.jsonc`: directorio estático `./`, ruta de fallback SPA.

Para publicación desde Cloudflare, conectar el repositorio anterior a la rama `main`:
- Build command: vacío
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

La integración GitHub ↔ Cloudflare debe estar conectada para que cada nuevo commit se despliegue automáticamente.

## Enlace del proyecto

https://noelia-perucci-demo.alejolunavnc.workers.dev/
