# Universidad de Nariño — Preinscripción y recepción de material

Página pública para que estudiantes, profesionales y egresados se **preinscriban**
a eventos y **envíen material**. Todo se recepciona directo en **Notion**, con una
cola/concurrencia eficiente que evita saturar la API y admite casi cualquier tipo
de archivo (hasta 5 GB, comprimiendo a ZIP los no soportados por Notion).

## Flujo

```
INICIO → botones cuadrados (uno por evento = subpágina de Notion)
   │
   ├─ evento simple (MUD/MAD/HOMUS) → MENÚ directo
   └─ evento con año (DEX) → elige Año / Periodo → MENÚ
        │
        ├─ Preinscripción → formulario → se guarda en 1REGISTRO
        └─ Cargar material → datos + archivos → se guarda en 2DATA
```

La jerarquía (año → periodo → 1REGISTRO/2DATA) se **crea sola** en Notion si no
existe, y se reutiliza si ya existe (sin duplicados, incluso con varios envíos
simultáneos). Para añadir un evento, crea otra subpágina en la página madre de
Notion y aparecerá como un botón.

## Dos formas de desplegar

Este proyecto corre en **dos entornos** con el mismo frontend:

| Entorno | Backend | Cuándo usarlo |
|---|---|---|
| **Node / Express** (`server.ts`) | servidor tradicional | desarrollo local, VPS |
| **Cloudflare Pages** (`functions/`) | Pages Functions | producción recomendada (como ENVI) |

### Desarrollo local (Node)
```bash
cp .env.example .env     # completa NOTION_SECRET y NOTION_ID_PAGE
npm install
npm run dev              # http://localhost:3000
```

### Probar las Functions de Cloudflare localmente
```bash
# .dev.vars contiene NOTION_SECRET y NOTION_ID_PAGE (no se commitea)
npm run build:pages
npx wrangler pages dev dist --compatibility-date 2024-11-01
```

### Desplegar a Cloudflare Pages (producción)
1. Sube el repo a GitHub y conéctalo en Cloudflare Pages, o usa:
   ```bash
   npm run build:pages
   npx wrangler pages deploy dist
   ```
2. **Build command**: `npm run build:pages` · **Output dir**: `dist`
3. En **Settings → Variables and secrets** define:
   - `NOTION_SECRET`, `NOTION_ID_PAGE` (requeridas)
   - `GMAIL_*` (opcionales, para el correo de confirmación)

## Correo de confirmación (opcional)
Si configuras las variables `GMAIL_*` (Gmail API vía OAuth2, sin SMTP), cada
persona recibe un correo al **preinscribirse** y al **enviar material**. Si no se
configuran, el sistema funciona igual sin enviar correos.

## Notas de producción (concurrencia)
- **Cliente** (`src/uploadService.ts`): semáforo adaptativo (AIMD) + pool de 3
  partes por archivo grande → sube rápido sin saturar Notion.
- **Cloudflare** (`functions/api/upload-part.ts`): hace *streaming puro* del chunk
  a Notion (no lo parsea) para no exceder el límite de CPU por request.
- **Toggles sin duplicar**: `functions/_shared/notion.ts` usa *crear-y-reconciliar*
  (tras crear, re-lista y conserva uno solo), porque en Cloudflare no hay memoria
  compartida entre invocaciones. En Node se usa además un lock en memoria.
- Límite por archivo en la vía single-part de Cloudflare: **95 MB** (los mayores
  van por multipart automáticamente).

## Estructura
```
src/            frontend (React + Vite)
server.ts       backend Node/Express (dev + VPS)
functions/      backend Cloudflare Pages Functions (producción)
email.ts        correos (Node); functions/_shared/email.ts (Cloudflare)
```
