# Libretorio-Scanner

Servicio encargado de recorrer uno o más roots de biblioteca, contrastar el resultado con la base de datos y mantener listos los artefactos que consumen `Libretorio` y `Libretorio-ng`.

## Qué hace hoy

En cada corrida:

1. escanea el root configurado
2. detecta carpetas especiales sin expandirlas luego como archivos normales
3. elimina de la DB lo que ya no existe en disco
4. completa metadata local y remota para archivos nuevos
5. inserta en DB apenas cada archivo nuevo ya tiene la metadata necesaria
6. genera artefactos especiales y cache comic en fases separadas

## Flujo actual

La orquestación principal está en [ScannerService.ts](/media/work/OneDrive/Personal-Git/Libretorio/Libretorio-Scanner/src/services/ScannerService.ts).

Fases de `scanCompareUpdate`:

1. `scan`
2. contraste con DB y eliminación de ausentes
3. `metadata + insert` de nuevos
4. artefactos `.zip` para especiales no-comic
5. cache comic/manga en chunks

## Tipos de artefactos

### 1. Archivo comic comprimido

Aplica a archivos normales declarados explícitamente como comic por extensión `cb*`.

Extensiones aceptadas:

- `cbr`
- `cbz`
- `cb7`
- `cbt`

El backend real igual se valida por `magic bytes`, no solo por extensión.

Ejemplos soportados:

- `cbr` detectado como `rar`
- `cbz` detectado como `zip`
- `cb7` detectado como `7z`
- `cbt` detectado como `tar`

Salida:

- `cache/<coverId>/<coverId>_N.cache`

### 2. Carpeta especial `COMIC-MANGA`

Salida:

- `cache/<coverId>/<coverId>.zip`
- `cache/<coverId>/<coverId>_N.cache`

Importante:

- el `.zip` se construye desde el contenido original
- los `_N.cache` se construyen desde páginas ya ordenadas y, si corresponde, redimensionadas

### 3. Carpetas especiales `EPUB` y `AUDIOBOOK`

Salida:

- `cache/<coverId>/<coverId>.zip`

No generan `_N.cache`.

## Worker nativo

La extracción y normalización de comics vive en `native/worker/`.

Responsabilidades del worker:

- detectar backend real por `magic bytes`
- aceptar archivo comprimido o carpeta `COMIC-MANGA`
- ordenar páginas y filtrar basura
- aplicar política de redimensionamiento
- escribir `raw/`
- escribir `manifest.json`

No hace:

- chunking
- base64
- escritura de `_N.cache`
- actualización de DB
- generación del `.zip` descargable

Eso sigue en TypeScript.

## Política de redimensionamiento

La política sigue el criterio de `Comiscopio`, pero sin miniaturas ni previews.

Defaults actuales:

- `SCAN_CACHE_RESIZE_ENABLED=true`
- `SCAN_CACHE_READER_MAX_DIMENSION=2400`
- `SCAN_CACHE_READER_QUALITY=82`
- `SCAN_CACHE_READER_FORMAT=jpeg`
- `SCAN_CACHE_VIPS_CONCURRENCY=1`

Regla:

- si `max(width, height) <= 2400`, la página hace `bypass`
- si supera ese umbral, se redimensiona y reencodea
- el chunking ocurre después, usando el `raw/` final

## Contrato de elegibilidad comic

El scanner no intenta adivinar si un comprimido genérico es comic.

Entran al precalentamiento automático solo:

- carpetas especiales `COMIC-MANGA`
- archivos `cbr`, `cbz`, `cb7`, `cbt`

No entran automáticamente:

- `.rar`, `.zip`, `.7z`, `.tar` genéricos
- archivos con extensión comic `cb*` cuyo `magic bytes` no correspondan a `rar|zip|7z|tar`

Importante:

- si un archivo está mal nombrado, la corrección esperada es manual
- una vez renombrado correctamente a `cb*`, el próximo scan lo procesará
- si una extensión `cb*` no coincide con su formato real, el scanner usa el backend detectado por `magic bytes`

## Robustez del cache

El flujo de cache actual implementa:

- staging en `cache/.scanner-build/`
- limpieza de staging residual al inicio de cada corrida
- garbage collection final de directorios de cache huérfanos contra la lista viva de `coverId` en DB
- validación de cache existente antes de hacer `skip`
- promoción atómica a `cache/<coverId>/`
- preservación del cache final previo si un rebuild falla
- estado por item en `_scanner_state.json`
- estado `ready` reutilizable con `buildOutcome="complete|partial"`
- tolerancia a páginas individuales dañadas; si al menos una página válida sobrevive, la cache queda `ready` con `buildOutcome="partial"`

El estado por item también se reutiliza para:

- reutilizar items ya marcados como `ready` cuando el `fileHash` y el backend no cambian

## Shared storage

En este proyecto, `copyStaticAssets.ts` crea symlinks hacia storage compartido:

- libros: `/media/RIGO7/BACKUP/LIBROS`
- covers: `/media/RIGO7/Libretorio-conf/covers`
- cache: `/media/RIGO7/Libretorio-conf/cache`
- temp covers: `/media/RIGO7/Libretorio-conf/temp_covers`

Referencia: [copyStaticAssets.ts](/media/work/OneDrive/Personal-Git/Libretorio/Libretorio-Scanner/copyStaticAssets.ts)

Si el host de producción usa otras rutas, este archivo debe ajustarse antes del despliegue.

## Scripts útiles

Desde [package.json](/media/work/OneDrive/Personal-Git/Libretorio/Libretorio-Scanner/package.json):

- `npm test -- --runInBand`
- `npm run build`
- `npm run build-native-worker`
- `npm run clean:native-worker`
- `npm run serve`

## Dependencias de producción

### Si vas a compilar el worker nativo en producción

```bash
sudo apt update
sudo apt install -y \
  nodejs \
  npm \
  build-essential \
  cmake \
  pkg-config \
  libarchive-dev \
  libvips-dev \
  libunrar-dev \
  libunrar-headers
```

### Si vas a copiar el binario ya compilado y solo ejecutar el scanner

```bash
sudo apt update
sudo apt install -y \
  nodejs \
  npm \
  libarchive13t64 \
  libvips42t64 \
  libunrar5t64
```

Opcional, recomendado como red de seguridad para el fallback legacy de RAR:

```bash
sudo apt install -y unrar
```

Notas:

- el proyecto declara `Node >=24.15.0 <25`; usar el runtime Node 24 acordado para estos servicios
- `7z` no hace falta instalarlo por `apt`; el proyecto usa `7zip-bin` desde `node_modules`

## Verificación mínima

Antes de desplegar:

```bash
npm test -- --runInBand
npm run build
```

Al momento de actualizar este documento, ambas verificaciones pasan en el estado actual del proyecto.

## Conversiones PDF al final del scan

La fase nueva esta implementada y probada localmente, pero **desactivada por defecto**.
Se activa exclusivamente con `SCAN_PDF_CONVERSIONS_ENABLED=true`, despues de aplicar
la migracion `Libretorio-postgresql/20260928_document_conversions.sql`, validar los
conversores bajo el usuario del servicio y coordinar que el backend deje de convertir.
No activar dos escritores sobre los mismos PDFs.

- Consulta `archive` por `scan_root_id` en lotes de 50, con cursor por ID; no carga todos los candidatos en memoria.
- Ejecuta una conversion a la vez, dentro del scan y despues de ZIP, comics, audio, GC y snapshot.
- Conserva `cache/<coverId>/<coverId>.pdf`. Si el ZIP reconstruido elimino el PDF, esta fase lo regenera.
- Usa Calibre del proyecto (`src/services/calibre`, copiado a `dist/services/calibre`), LibreOffice o HTMLDOC.
- Requiere Linux, Bubblewrap, prlimit, file y pdfinfo; la recuperacion sintactica requiere tambien qpdf y pdftotext. Si falla el aislamiento, no ejecuta un fallback sin proteccion.
- Registra estados en `document_conversions`, resumen por corrida en `document_conversion_runs` y logs `pdf-conversion:*`.
- Respalda los PDFs sin procedencia como archivos `cache/<coverId>.legacy-<sha256>.pdf`, antes de reemplazarlos.

**Antes del primer scan habilitado, respaldar los dos PDFs heredados identificados**:
la fase previa de ZIP podria eliminarlos antes de llegar a la fase PDF. El respaldo
automatico final conserva los que sobreviven hasta ese punto; no sustituye ese respaldo previo.

Configuracion opcional:

| Variable | Predeterminado |
| --- | --- |
| `PDF_CONVERSION_BATCH_SIZE` | 50, maximo 500 |
| `PDF_CONVERSION_TIMEOUT_MS` | 900000 por conversion |
| `PDF_CONVERSION_MEMORY_BYTES` | 2147483648, suma de RSS muestreada cada 250 ms |
| `PDF_CONVERSION_CALIBRE_MEMORY_BYTES` | 6442450944, limite RSS especifico de Calibre |
| `PDF_CONVERSION_ADDRESS_SPACE_BYTES` | 1099511627776 por proceso, memoria virtual |
| `PDF_CONVERSION_CPU_SECONDS` | 900 por proceso |
| `PDF_CONVERSION_MAX_BYTES` | 4294967296 por archivo de salida |
| `PDF_CONVERSION_DIAGNOSTICS_DIR` | `logs/pdf-conversions` del proyecto, fuera de la cache |

El monitor RSS no es un limite duro de cgroup: puede haber picos entre muestras y
las paginas compartidas pueden contarse varias veces. El limite de espacio virtual
es distinto; fijarlo en 2 u 8 GiB hizo fallar Calibre en las pruebas reales.
Calibre dispone de 2048 descriptores por proceso; las otras herramientas conservan 256.

La receta `libretorio-pdf-v2` prepara los EPUB en carpeta a partir del ZIP existente,
verificando contenido contra la fuente. Si falta o esta desactualizado, reutiliza
el generador de ZIP y reemplaza solo ese archivo, no su carpeta de cache. Calibre
recibe una copia temporal `.epub`; los originales permanecen de solo lectura.
Para errores PoDoFo comprobados se intenta recuperar la portada a PNG sin cambiar
sus pixeles. Para dos errores sintacticos conocidos se intenta normalizar con
qpdf, comprobando paginas y texto; no se reparan PDFs ya publicados en sitio.
Los diagnosticos acotados por item se conservan en
`<PDF_CONVERSION_DIAGNOSTICS_DIR>/<run>/<archiveId>.json`, incluso tras eliminar
los temporales de conversion o comenzar otro scan. No configurar esta ruta dentro
de `.scanner-build` ni de una carpeta publica. Recursos omitidos detectados
impiden publicar el PDF.

Los fallos de documentos permiten continuar. Los fallos de PostgreSQL, almacenamiento,
aislamiento o lease detienen la fase. `timeout`, fuente modificada o archivo ausente
tienen espera de una hora y hasta tres intentos por firma/receta; errores permanentes
se difieren hasta que cambie la fuente/receta o se autorice un reintento dirigido.
Al comenzar una nueva fase con la lease adquirida, los estados `processing` de
la misma raiz se reconcilian para permitir reintento; se conserva el digest que
permite recuperar una publicacion interrumpida. Un intento de escritura sobre
`/input` protegido es fallo del documento, no prueba de averia del disco del host.

Pruebas y restricciones de la implementacion inicial:
[resultado-conversiones-pdf-local-2026-09-28.md](../resultado-conversiones-pdf-local-2026-09-28.md).
Revision v2, correcciones, respaldo, limpieza y despliegue del 30/09:
[revision-cruzada-conversiones-2026-09-30.md](../revision-cruzada-conversiones-2026-09-30.md).
