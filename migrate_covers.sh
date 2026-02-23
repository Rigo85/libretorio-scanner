#!/bin/bash
# Migración one-time: convierte todos los covers JPG existentes a WebP.
# Ejecutar en producción ANTES de desplegar las nuevas versiones del backend y frontend.
#
# Uso:
#   chmod +x migrate_covers.sh
#   ./migrate_covers.sh /ruta/a/covers
#   ./migrate_covers.sh /ruta/a/covers 4   # con 4 workers en paralelo (default)

set -euo pipefail

COVERS_DIR="${1:?Uso: $0 <directorio_covers> [workers]}"
WORKERS="${2:-4}"
QUALITY=85

if ! command -v cwebp &>/dev/null; then
    echo "ERROR: cwebp no encontrado. Instalar con: sudo apt install webp"
    exit 1
fi

TOTAL=$(find "$COVERS_DIR" -name "*.jpg" | wc -l)
if [ "$TOTAL" -eq 0 ]; then
    echo "No se encontraron archivos .jpg en $COVERS_DIR"
    exit 0
fi

echo "Convirtiendo $TOTAL covers JPG → WebP (calidad=$QUALITY, workers=$WORKERS)..."
echo ""

CONVERTED=0
FAILED=0

export QUALITY
find "$COVERS_DIR" -name "*.jpg" | \
xargs -P "$WORKERS" -I{} bash -c '
    f="{}"
    base="${f%.jpg}"
    if cwebp -q "$QUALITY" "$f" -o "${base}.webp" 2>/dev/null; then
        rm "$f"
    else
        echo "WARN: no se pudo convertir $f" >&2
    fi
'

WEBP_COUNT=$(find "$COVERS_DIR" -name "*.webp" | wc -l)
JPG_LEFT=$(find "$COVERS_DIR" -name "*.jpg" | wc -l)

echo ""
echo "=== Resultado ==="
echo "WebP generados : $WEBP_COUNT"
echo "JPG sin convertir: $JPG_LEFT"
echo ""
echo "Tamaño final del directorio:"
du -sh "$COVERS_DIR"
