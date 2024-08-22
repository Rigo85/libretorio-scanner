# Usar una imagen base con Node.js instalado
FROM node:20.16

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
