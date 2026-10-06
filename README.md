# formdata — Preinscripción y recepción de material

Sistema simple para gestionar **preinscripciones** y **material** (estudiantes,
profesionales y egresados), que recepciona directo en **Notion** mediante una
cola eficiente que evita saturar la API y admite prácticamente cualquier tipo
de archivo (hasta 5 GB por archivo, comprimiendo a ZIP los no soportados).

> La carpeta `UpZ/` es solo el **sistema de referencia** del que se tomaron las
> piezas del motor (cola de Notion, subida multiparte y compresión). No forma
> parte de este sistema.

## Flujo

```
INICIO → botones cuadrados centrados, uno por categoría de Notion
   │       (iniciales grandes + nombre; "agregar más" = crear otro en Notion)
   ▼
MENÚ → 2 opciones:
   ├─ Preinscripción  → formulario de datos
   └─ Cargar material → subir archivos del proyecto preinscrito
   │
   ▼
Todo se recepciona en Notion (como un bloque desplegable por persona)
```

Las **categorías** son los proyectos (toggles / subpáginas) de la página de
Notion configurada. Para agregar una categoría nueva, basta crear otro proyecto
en esa página de Notion: aparecerá automáticamente como un botón.

## Configuración

1. Copia `.env.example` a `.env` y completa:
   - `NOTION_SECRET`: token de tu integración interna de Notion.
   - `NOTION_ID_PAGE`: id de la página de Notion donde se reciben las entregas
     (comparte esa página con la integración).
2. Instala dependencias: `npm install`
3. Desarrollo: `npm run dev` → http://localhost:3000
4. Producción: `npm run build && npm start`

## Endpoints del servidor

- `GET  /api/config` — indica si Notion está configurado.
- `GET  /api/projects` — lista las categorías (proyectos de Notion).
- `POST /api/upload-file` — sube un archivo pequeño (≤20 MB) a Notion.
- `POST /api/upload-init` / `upload-part` / `upload-complete` — subida multiparte
  (archivos grandes, hasta 5 GB).
- `POST /api/submit` — crea el registro (preinscripción o material) en Notion.
