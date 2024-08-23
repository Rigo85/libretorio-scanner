# Usar una imagen base con Node.js instalado
FROM node:20.16

# Necesario para el calibre
RUN apt-get update && \
    apt-get install -y \
    python3-pyqt5 \
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
    libopengl0 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Establecer el directorio de trabajo
WORKDIR /app

# Copiar el proyecto desde la carpeta local al contenedor
COPY . .

# Instalar dependencias
RUN npm install

# Compilar la Aplicación TypeScript
RUN npm run build

# Exponer el puerto en el que se ejecutará la aplicación
EXPOSE 3006

# Comando para ejecutar la aplicación
CMD ["node", "dist/server.js"]
