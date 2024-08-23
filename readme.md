
# Pasos:
- **Instalar docker**: 
  - `https://docs.docker.com/engine/install/ubuntu/`
  - `sudo usermod -aG docker azureuser`
  - `newgrp docker`
- **Crear red**: 
    - Revisar *Libretorio-posgresql*.
- **Desplegar REDIS**: 
    - Revisar *Libretorio-posgresql*.
- **Desplegar el PostgreSQL**
  - Revisar *Libretorio-posgresql*.
- **Construir la imagen**:
  - `docker build -t libretorio-scanner .` 
- **Ejecutar contenedor con la imagen creada**:
  - `docker run -d -p 3006:3006 --env-file=./.env-docker --name libretorio-scanner --network mi-red --restart unless-stopped \
  -v /media/RIGO7/BACKUP/LIBROS:/app/dist/public/books \
  -v /media/RIGO7/Libretorio-conf/cache:/app/dist/public/cache \
  -v /media/RIGO7/Libretorio-conf/covers:/app/dist/public/covers \
  -v /media/RIGO7/Libretorio-conf/temp_covers:/app/dist/public/temp_covers \
  libretorio-scanner` 
- **Entrar al docker por temas de depuración**:
  - `sudo docker exec -ti libretorio-scanner /bin/bash`
- **Revisar logs del backend**:
  - `sudo docker logs -t libretorio-scanner -f`
- **Entrar a REDIS para revisar estado de las colas**:
  - `docker exec -it mi-redis /bin/bash`
  - `redis-cli`
  - `llen FileWatcherQueue`, revisar en la configuración del container el nombre correcto de la cola.