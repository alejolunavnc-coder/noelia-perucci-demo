# Noelia Perucci — Demo visual V3

Prototipo de muestra para presentar el rediseño de la página móvil de Noelia Perucci.

- **Inicio:** portada editorial, presentación de Noelia y acceso a los planes.
- **Entrenamientos:** asesoría integral y plan de entrenamiento.
- **Contacto:** consulta simulada.
- **Sin** suplementos ni preparación para competir.
- **Sin** pagos ni envío real de formularios.

## Publicar en Cloudflare Pages

1. Entrar a **Cloudflare → Workers & Pages → Create application → Pages → Connect to Git**.
2. Seleccionar GitHub y el repositorio `alejolunavnc-coder/noelia-perucci-demo`.
3. Elegir `main` como rama de producción.
4. En **Framework preset**, elegir **None**.
5. **Build command:** dejar vacío (o usar `exit 0`).
6. **Build output directory:** `.` (raíz del repositorio).
7. Hacer clic en **Save and Deploy**.
8. Compartir la URL pública `*.pages.dev` que muestre Cloudflare.

**Nota:** `index.html` contiene todo lo necesario (estilos, JavaScript y fotografías embebidas). No requiere Node, npm, variables de entorno ni base de datos.

**Solo demostración:** no usar para cobrar ni recibir solicitudes reales.
