# Noelia Perucci — Demo visual V3

Prototipo visual navegable para presentar el diseño a Noelia. No acepta pagos ni envía formularios reales.

## Publicar desde la pantalla actual de Cloudflare Workers (Import a repository)

Este repositorio ya está preparado con `wrangler.jsonc` para desplegar los archivos HTML como **Workers Static Assets**, sin instalar nada localmente.

1. En Cloudflare, seleccionar el repositorio `alejolunavnc-coder/noelia-perucci-demo`.
2. **Project name:** `noelia-perucci-demo` (debe coincidir con `wrangler.jsonc`).
3. **Build command:** vacío.
4. **Deploy command:** `npx wrangler deploy` (valor predeterminado).
5. **Preview command:** dejar el valor predeterminado.
6. **Path:** `/` (raíz).
7. **Variables, API token y otros ajustes avanzados:** dejar sin completar.
8. Presionar **Deploy**. Cloudflare generará un enlace `*.workers.dev`.

Las modificaciones posteriores subidas a `main` dispararán publicaciones automáticas.

## Contenido

- Inicio: portada editorial y presentación de Noelia.
- Entrenamientos: dos planes.
- Contacto: consulta simulada.
- No incluye suplementos, carrito ni preparación para competir.

## Publicación alternativa con Cloudflare Pages

Este repositorio también contiene `index.html` en la raíz y puede conectarse mediante Pages Git integration, con framework None, sin build, y directorio de salida `.`.
