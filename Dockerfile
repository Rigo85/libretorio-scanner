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
    	jq \
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
		xz-utils \
        libqt5webengine5 \
        libqt5webenginewidgets5 \
        libqt5webchannel5 \
        libqt5positioning5 \
        libqt5printsupport5 \
        libqt5svg5-dev \
        qtwebengine5-dev && \
    apt-get install -y \
		speech-dispatcher && \
	echo "**** install calibre ****" && \
    mkdir -p \
    	/opt/calibre && \
  	if [ -z ${CALIBRE_RELEASE+x} ]; then \
    	CALIBRE_RELEASE=$(curl -sX GET "https://api.github.com/repos/kovidgoyal/calibre/releases/latest" \
    	| jq -r .tag_name); \
  	fi && \
  	CALIBRE_VERSION="$(echo ${CALIBRE_RELEASE} | cut -c2-)" && \
  	CALIBRE_URL="https://download.calibre-ebook.com/${CALIBRE_VERSION}/calibre-${CALIBRE_VERSION}-x86_64.txz" && \
  	curl -o \
    	/tmp/calibre-tarball.txz -L \
    	"$CALIBRE_URL" && \
  	tar xvf /tmp/calibre-tarball.txz -C \
    	/opt/calibre && \
  	/opt/calibre/calibre_postinstall && \
  	dbus-uuidgen > /etc/machine-id && \
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
