# Usar una imagen base de Ubuntu
FROM ubuntu:24.04

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
    apt-get install -y \
		libopengl0 \
		libqpdf29t64 \
		python3 \
		python3-pyqt6 \
        python3-pyqt6.qtwebengine \
        libegl1-mesa-dev \
        libopengl0 && \
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
