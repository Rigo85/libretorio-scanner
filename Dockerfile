# Usar una imagen base con Node.js instalado
FROM node:20.16

# Instalar las dependencias necesarias para Calibre y agregar el repositorio de Calibre
RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common && \
    add-apt-repository ppa:kovidgoyal/calibre && \
    apt-get update && apt-get install -y --no-install-recommends \
    calibre \
    dbus \
    fcitx-rime \
    fonts-wqy-microhei \
    libnss3 \
    libopengl0 \
    libqpdf29t64 \
    libxkbcommon-x11-0 \
    libxcb-cursor0 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-render-util0 \
    libxcb-xinerama0 \
    libxdamage1 \
    poppler-utils \
    python3 \
    python3-xdg \
    ttf-wqy-zenhei \
    wget \
    xz-utils \
    speech-dispatcher \
    python3-pyqt5 \
    python3-pyqt5.qtwebengine && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Establecer el directorio de trabajo
WORKDIR /app

# Copiar el proyecto desde la carpeta local al contenedor
COPY . .

# Instalar dependencias de Node.js
RUN npm install

# Compilar la Aplicación TypeScript
RUN npm run build

# Exponer el puerto en el que se ejecutará la aplicación
EXPOSE 3006

# Comando para ejecutar la aplicación
CMD ["node", "dist/server.js"]
