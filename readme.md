# Libretorio-Scanner

Servicio de preparacion del catalogo de Libretorio. Recorre las raices de la
biblioteca, contrasta disco y base de datos, extrae metadata y deja listos los
artefactos que utilizan el backend y sus lectores.

La presentacion general esta en
**[Libretorio-ng](https://github.com/Rigo85/libretorio-ng#readme)**. Este servicio
trabaja por corridas programadas o solicitadas; no promete sincronizacion
instantanea ante cada cambio en disco.

## Flujo del scan

La orquestacion vive en [ScannerService.ts](src/services/ScannerService.ts):

1. Adquiere el control de ejecucion y recorre la raiz, detectando carpetas
   especiales sin volver a expandirlas como archivos independientes.
2. Contrasta el catalogo con el disco y elimina registros de materiales ausentes.
3. Obtiene metadata local y, cuando esta habilitado, consulta Open Library para
   nuevos materiales; inserta los registros preparados.
4. Prepara ZIP descargables para carpetas especiales y cache de comics/manga.
5. Extrae o reutiliza metadata de audio, incluida duracion y capitulos.
6. Actualiza el arbol, limpia cache huerfana y reconstruye el inventario de cache.
7. Si esta habilitado, verifica y genera las conversiones PDF elegibles al final.

Redis mantiene la lease de ejecucion para evitar scans superpuestos. La fase PDF
es secuencial; no existe una cola de conversiones independiente del scan.

## Artefactos preparados

| Fuente | Salida o estado |
| --- | --- |
| Comic comprimido `cba`, `cbr`, `cbz`, `cb7`, `cbt` | Paginas agrupadas en `cache/<coverId>/<coverId>_N.cache`. |
| Carpeta especial `COMIC-MANGA` | ZIP del original y bloques de paginas para el visor. |
| Carpeta especial `EPUB` o `AUDIOBOOK` | ZIP descargable; no bloques de comic. |
| Audio elegible | Metadata tecnica, duracion y capitulos en PostgreSQL. |
| Documento convertible | PDF en `cache/<coverId>/<coverId>.pdf` y estado de conversion en PostgreSQL. |

Los filtros por extension seleccionan candidatos; despues se inspecciona su
contenido. No se considera comic cualquier ZIP/RAR generico. Un archivo `.cbr`
con contenido ZIP se procesa con el formato detectado, no con el supuesto del
nombre. Se admiten contenedores comic ACE, RAR, ZIP, 7z y TAR.

El worker de [native/worker](native/worker) extrae, ordena y normaliza las paginas.
TypeScript mantiene el chunking, los estados, la publicacion y el catalogo.
La cache usa staging y promocion atomica, conserva el resultado previo si falla
la reconstruccion y distingue resultados completos y parciales.

## Audiolibros

La seleccion inicial admite `.mp3`, `.wav`, `.m4a`, `.m4b`, `.ogg` y `.flac`.
La deteccion de contenido precede a la extraccion con `ffprobe`: extension y
contenedor real no tienen por que coincidir. El scanner registra resultados y
fallos; reutiliza metadata vigente cuando no cambia la firma de la fuente ni la
version del extractor. La ausencia de capitulos no implica que el audio sea
invalido.

El backend consulta esta informacion para las pistas y capitulos del reproductor;
no necesita repetir esta extraccion cada vez que se abre un audiolibro.

## Conversiones PDF

**EPUB no participa en la conversion automatica**, ni como archivo ni como
carpeta especial. Se mantiene su lector nativo y el ZIP de las carpetas EPUB.

Los formatos actualmente seleccionados son `doc`, `docx`, `ppt`, `pptx`, `xls`,
`xlsx`, `rtf`, `txt`, `md`, `html`, `htm` y `lit`. La lista vigente esta en
[DocumentConversion.ts](src/models/interfaces/DocumentConversion.ts).

- La fase se habilita con `SCAN_PDF_CONVERSIONS_ENABLED=true`; por defecto no se ejecuta.
- Selecciona candidatos de PostgreSQL en lotes por ID, sin acumular una lista
  adicional de todos los documentos a convertir.
- Reutiliza PDFs validos y genera los faltantes o desactualizados. Si una fase
  previa reconstruyo una carpeta de cache y elimino su PDF, lo vuelve a preparar.
- Usa LibreOffice para Office/RTF, HTMLDOC para HTML y Calibre para TXT/MD/LIT.
  Calibre procede de `src/services/calibre`, no de una instalacion elegida por PATH.
- Ejecuta las herramientas aisladas con Bubblewrap, valida la salida y registra
  estados `processing`, `ready` o `failed`, causas y resumen por conversor.
- Reconcilia conversiones interrumpidas al comenzar la siguiente corrida.
  **No reintenta indefinidamente todos los fallos**: distingue reintentables,
  agotados y casos que necesitan intervencion.

El backend solo consulta estos estados y archivos; no debe convertirse en un
segundo escritor de la misma cache. Configuracion, limites y diagnosticos en la
[guia de operacion](docs/operacion.md).

## Preparacion y ejecucion

Requiere Node.js `>=24.15.0 <25`, npm, PostgreSQL, Redis, almacenamiento compartido
y las herramientas nativas indicadas en la [guia de operacion](docs/operacion.md).
Aplicar las migraciones correspondientes de
[Libretorio-postgresql](https://github.com/Rigo85/libretorio-postgresql) antes de
activar audio o conversiones contra una base existente.

**Antes de `npm ci`**, revisar [copyStaticAssets.ts](copyStaticAssets.ts): el
`postinstall` compila el worker y crea enlaces a rutas concretas del host. Preparar
las dependencias, la configuracion y el almacenamiento antes de instalar o arrancar.

```bash
npm ci
npm test -- --runInBand
npm run build
npm run serve
```

El servicio programa scans segun `CRON_SCHEDULE`; arrancarlo no es una operacion
de solo lectura. Usar una base y una biblioteca aisladas para pruebas.
No exponer su puerto HTTP a Internet: sus rutas operativas no utilizan las
sesiones de usuario del backend.

## Documentacion y licencia

- [Configuracion, dependencias, cache y seguimiento de corridas](docs/operacion.md).
- [Notas historicas conservadas del README anterior](docs/notas-implementacion-historicas.md).
- [Backend consumidor](https://github.com/Rigo85/libretorio#readme).
- [Licencia AGPL v3](LICENSE.txt). Los componentes de terceros tienen sus propias licencias.
