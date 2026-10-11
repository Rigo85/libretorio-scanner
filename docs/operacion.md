# Operacion del scanner

Volver al [README](../readme.md). Esta guia describe la configuracion del codigo;
no sustituye la revision del host y de sus respaldos antes de un despliegue.

## Configuracion y almacenamiento

El servicio lee `.env` desde su directorio de trabajo. Consultar
[configuration.ts](../src/config/configuration.ts).

| Variable | Valor predeterminado o finalidad |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Conexiones a PostgreSQL y Redis. |
| `PORT` | `3006`. Puerto operativo interno, no publico. |
| `NODE_ENV` | `development`; configurar para el entorno de ejecucion. |
| `CRON_SCHEDULE` | `0 */1 * * *`, zona `America/Lima`. |
| `ACTION` | `update-books-info`, accion del endpoint operativo `/check/:action`. |
| `CAN_USE_OPENLIBRARY_API` | `false`. Consulta remota de metadata para nuevos materiales. |
| `SCAN_CONCURRENCY` | `4`, procesamiento de metadata de nuevos materiales. |
| `SCAN_CACHE_CONCURRENCY` | `1`, construccion de cache comic. |
| `AUDIO_FFPROBE_PATH` | `/usr/bin/ffprobe`. |
| `SCAN_PDF_CONVERSIONS_ENABLED` | Activar con `true`; no habilitado por defecto. |

La raiz utilizada por el servicio pasa por `dist/public/books`; las raices
registradas en la base deben corresponder al almacenamiento accesible.
[copyStaticAssets.ts](../copyStaticAssets.ts) enlaza actualmente libros con
`/media/RIGO7/BACKUP/LIBROS` y portadas/cache con `/media/RIGO7/Libretorio-conf`.
Son rutas de una instalacion concreta, no requisitos de nombre para una nueva.

Una raiz incorrecta o incompleta afecta la reconciliacion del catalogo. Verificar
montajes, permisos, enlaces y respaldos antes de ejecutar. El endpoint operativo
acepta el inicio del trabajo, no confirma que una corrida haya terminado bien;
revisar el resumen y los logs.

## Herramientas

- Node 24 compatible con el rango de [package.json](../package.json). No asumir
  que el paquete `nodejs` del sistema instala la version requerida.
- Para compilar el worker: compilador C/C++, CMake, pkg-config y dependencias de
  desarrollo de libarchive, libvips y libunrar. Consultar
  [native/worker/CMakeLists.txt](../native/worker/CMakeLists.txt). En ejecucion se
  necesitan sus bibliotecas compartidas y los recursos auxiliares del worker.
- `file` y `ffprobe` para detectar y analizar audio.
- `7zip-bin` se instala con npm; el build asigna permisos a su binario Linux x64.
- Calibre preparado en `src/services/calibre` para las funciones que lo usan;
  ese directorio no se distribuye en Git.
- Para PDF: LibreOffice, HTMLDOC, Bubblewrap, `prlimit`, `file` y `pdfinfo`.
  La recuperacion sintactica usa ademas `qpdf` y `pdftotext`.

Verificar las herramientas con el usuario real del servicio y su aislamiento.
Si Bubblewrap o sus permisos no funcionan, no habilitar las conversiones ni
sustituir el aislamiento por ejecucion sin proteccion. Los nombres de paquetes
del sistema dependen de la distribucion y su version.

## Cache comic

| Variable | Predeterminado |
| --- | --- |
| `SCAN_CACHE_CHUNK_BYTES` | 10485760 (10 MiB) |
| `SCAN_CACHE_RESIZE_ENABLED` | `true` |
| `SCAN_CACHE_READER_MAX_DIMENSION` | `2400` |
| `SCAN_CACHE_READER_QUALITY` | `82` |
| `SCAN_CACHE_READER_FORMAT` | `jpeg` |
| `SCAN_CACHE_VIPS_CONCURRENCY` | `1` |

Las paginas cuya dimension mayor no supera el umbral no se redimensionan. El
worker prepara paginas y manifiesto; TypeScript genera los bloques finales.
El staging vive en `cache/.scanner-build/`. `_scanner_state.json` permite validar
la reutilizacion y distinguir `buildOutcome=complete|partial`: una cache `ready`
con paginas recuperadas parcialmente no implica que todas las paginas originales
sean legibles. No borrar la cache como procedimiento normal de reintento.

## Limites y seguimiento de PDF

| Variable | Predeterminado |
| --- | --- |
| `PDF_CONVERSION_BATCH_SIZE` | 50, maximo 500 |
| `PDF_CONVERSION_TIMEOUT_MS` | 900000 por conversion |
| `PDF_CONVERSION_MEMORY_BYTES` | 2147483648 (2 GiB), RSS del arbol de procesos |
| `PDF_CONVERSION_CALIBRE_MEMORY_BYTES` | 6442450944 (6 GiB), RSS para Calibre |
| `PDF_CONVERSION_ADDRESS_SPACE_BYTES` | 1099511627776 (1 TiB), espacio virtual por proceso |
| `PDF_CONVERSION_CPU_SECONDS` | 900 por proceso |
| `PDF_CONVERSION_MAX_BYTES` | 4294967296 (4 GiB) por archivo de salida |
| `PDF_CONVERSION_DIAGNOSTICS_DIR` | `logs/pdf-conversions` del proyecto |

RSS se muestrea cada 250 ms: no es un limite duro de cgroup y puede haber picos
entre muestras o memoria compartida contada mas de una vez. El espacio virtual
no equivale a RAM consumida. Calibre dispone de 2048 descriptores por proceso;
las otras herramientas, 256.

`document_conversions` conserva el estado por material; `document_conversion_runs`
registra cada corrida. Los logs `pdf-conversion:*` y los diagnosticos acotados
`<directorio>/<run>/<archiveId>.json` permiten separar causas por etapa y herramienta.
Mantener los diagnosticos fuera de carpetas publicas y del staging temporal.

El resumen distingue trabajo de la corrida e inventario final de estados, incluidos
fallos anteriores, reintentos pendientes/agotados y casos que requieren intervencion.
No interpretar el contador de errores nuevos como el total de pendientes.

Los fallos recuperables definidos por la politica tienen espera de una hora y
hasta tres intentos por firma/receta. Los permanentes se difieren hasta un cambio
de fuente/receta o una intervencion dirigida. PostgreSQL, almacenamiento,
aislamiento y perdida de lease pueden detener la fase: no son fallos de un libro.
La clasificacion vigente esta en
[ConversionFailureClassifier.ts](../src/services/ConversionFailureClassifier.ts).

Se intenta recuperar solo los errores conocidos de la receta y se valida la
salida antes de publicarla. `ready` indica que paso esas comprobaciones, no una
garantia de fidelidad visual pagina por pagina. Mantener revisiones de muestras
de PDFs tras cambios en herramientas o politica, sin regenerar todo por defecto.
