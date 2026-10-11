# Revision de dependencias: 2026-10-11

Validacion con Node 24.21.0 y npm 11.16.0, sin despliegue ni scan productivo.

## Cambios

- `sharp`: 0.35.4 -> 0.35.5, trasladado a devDependencies. Lo utilizan las pruebas
  de imagenes/comics; no se elimina de esas pruebas ni se instala en produccion.
- `shell-quote`: 1.10.0 -> 1.12.0; `handlebars`: 4.7.9 -> 4.7.10.
- Se elimina la dependencia directa `chokidar`, que el scanner no consume.
  Nodemon conserva su watcher como dependencia de desarrollo.
- No se altera el worker nativo ni la logica de deteccion, cache o conversiones.
  No se agregan overrides ni se ejecuta `npm audit fix --force`.

## Verificacion

- Instalacion limpia y `npm ls --all` sin errores.
- Build completo y **228 tests correctos**, incluidas las integraciones nativas
  de redimensionado, cache y archivos de comics con sharp actualizado.
- Compilacion y tests nativos en un contenedor Ubuntu 24.04 con libarchive,
  libvips y UnRAR, porque el host local no tenia sus paquetes de desarrollo.
- Instalacion separada con `npm ci --omit=dev --ignore-scripts` y `npm run 7z-perm`:
  no contiene sharp, chokidar, braces, shell-quote, handlebars ni sprintf-js.
- Arranque, respuesta HTTP y apagado correctos con servicios de prueba aislados.
  No se invoca el endpoint de escaneo; el cron se configura fuera de la prueba.
- Nodemon reinicia ante cambios; Concurrently ejecuta correctamente sus comandos.
- `npm audit --omit=dev`: **0 vulnerabilidades**, frente a 3 altas anteriores.
- Auditoria completa: **30 altas y 5 moderadas, 0 criticas**, frente a 38 alertas
  anteriores. El total incluye dependientes afectados, no 35 fallos independientes.

## Pendientes

Continuan dos avisos sin version corregida publicada en la fecha de revision:

- [braces, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  en la cadena de Nodemon/Jest/micromatch.
- [sprintf-js, GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c),
  en la cadena de Istanbul/js-yaml/argparse.

No exponer estas herramientas a entradas no confiables. No se ocultan los avisos
ni se aplican downgrades de Jest/Nodemon para hacer desaparecer el informe.
Tambien persisten deprecaciones de `string-similarity`, `inflight` y `glob`, cuya
sustitucion se evaluara separadamente.

El worker utiliza las bibliotecas nativas del sistema, no el libvips empaquetado
por sharp. La auditoria npm no cubre esas bibliotecas: actualizar sharp no equivale
a actualizarlas. Este cambio no modifica paquetes del host productivo.

El `postinstall` existente requiere compiladores y dependencias de desarrollo.
Construir con el entorno completo antes de preparar una instalacion `--omit=dev`;
en un artefacto ya compilado usar `--ignore-scripts` y restaurar permisos con
`npm run 7z-perm`. No omitir la compilacion/verificacion del worker nativo.
