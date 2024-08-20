
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
  - `docker build -t libretorio .` 
- **Ejecutar contenedor con la imagen creada**:
  - `docker run -d -p 80:3000 --env-file=./.env-docker --name libretorio --network mi-red --restart unless-stopped \
  -v /media/RIGO7/BACKUP/LIBROS:/app/dist/public/books \
  -v /media/RIGO7/Libretorio-conf/cache:/app/dist/public/cache \
  -v /media/RIGO7/Libretorio-conf/covers:/app/dist/public/covers \
  -v /media/RIGO7/Libretorio-conf/temp_covers:/app/dist/public/temp_covers \
  libretorio` 
- **Entrar al docker por temas de depuración**:
  - `sudo docker exec -ti libretorio /bin/bash`
- **Revisar logs del backend**:
  - `sudo docker logs libretorio -t`
- 