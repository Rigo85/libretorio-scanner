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

Aplica a archivos normales cuyo formato real es comic comprimido, detectado por `magic bytes` y no solo por extensión.

Ejemplos soportados:

- `cbr` / `rar`
- `cbz` / `zip`
- `cb7` / `7z`
- `cbt` / `tar`

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

## Reducción de falsos positivos

No todo `zip/rar/7z/tar` debe terminar en cache comic. El scanner ahora separa los casos así:

- `cbz`, `cbr`, `cb7` y `cbt` entran directo como candidatos comic
- colas multipart como `part02.rar`, `part03.rar`, `r00`, `r01` se descartan directo
- `zip`, `rar`, `7z` y `tar` genéricos pasan por un probe corto antes de entrar al pipeline de cache

Defaults actuales:

- `SCAN_CACHE_PROBE_ENABLED=true`
- `SCAN_CACHE_PROBE_MAX_ENTRIES=40`
- `SCAN_CACHE_PROBE_MIN_IMAGES=8`

Regla:

- si dentro de las primeras `40` entradas útiles aparecen al menos `8` imágenes válidas, el archivo entra
- si se llega al límite o el archivo termina con menos de `8` imágenes válidas, el archivo se ignora para cache comic
- cuando un archivo genérico se ignora, el scanner persiste ese resultado en `_scanner_state.json` con estado `ignored`
- si el `fileHash` y los thresholds no cambian, en corridas futuras ese archivo se salta sin reprobarlo

## Robustez del cache

El flujo de cache actual implementa:

- staging en `cache/.scanner-build/`
- limpieza de staging residual al inicio de cada corrida
- validación de cache existente antes de hacer `skip`
- promoción atómica a `cache/<coverId>/`
- preservación del cache final previo si un rebuild falla
- estado por item en `_scanner_state.json`

El estado por item también se reutiliza para:

- recordar resultados `ignored` de archivos comprimidos genéricos que no pasaron el probe
- evitar reprobar archivos ya marcados como `ready` o `ignored` cuando el `fileHash` y la configuración relevante no cambian

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

- el proyecto declara `Node 20.x`
- `7z` no hace falta instalarlo por `apt`; el proyecto usa `7zip-bin` desde `node_modules`

## Verificación mínima

Antes de desplegar:

```bash
npm test -- --runInBand
npm run build
```

Al momento de actualizar este documento, ambas verificaciones pasan en el estado actual del proyecto.
