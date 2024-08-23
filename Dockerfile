# Usar una imagen base de Ubuntu
FROM ubuntu:22.04

# Instalar Node.js 20.x y sus dependencias
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Verificar la versión de Node.js instalada
RUN node -v && npm -v

# Instalar las dependencias necesarias para Calibre
RUN \
    echo "**** install runtime packages ****" && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
		dbus \
		fcitx-rime \
		fonts-wqy-microhei \
		libnss3 \
		libopengl0 \
		libqpdf28 \
		libxkbcommon-x11-0 \
		libxcb-cursor0 \
		libxcb-icccm4 \
		libxcb-image0 \
		libxcb-keysyms1 \
		libxcb-randr0 \
		libxcb-render-util0 \
		libxcb-xinerama0 \
		poppler-utils \
		python3 \
		python3-xdg \
		ttf-wqy-zenhei \
		wget \
		python3-pyqt5 \
        python3-pyqt5.qtwebengine \
        libgl1-mesa-glx \
        libegl1-mesa \
        libxrandr2 \
        libxrandr-dev \
        libxss1 \
        libxcursor1 \
        libxcomposite1 \
        libasound2 \
        libxi6 \
        libxtst6 \
        libdbus-1-3 \
        libopengl0 \
		xz-utils && \
  	echo "**** cleanup ****" && \
  	apt-get clean && \
  	rm -rf \
		/tmp/* \
		/var/lib/apt/lists/* \
		/var/tmp/*

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
