FROM python:3.12-slim-bookworm
ARG BUILD_VERSION=0.3.11
ARG BUILD_ARCH=amd64
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.source="https://github.com/Qualified4/roadviewer-ha"
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 RV_DATA=/data/roadviewer RV_INGRESS_ONLY=1
RUN apt-get update && apt-get install -y --no-install-recommends nginx && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY schema /schema
COPY app /app
EXPOSE 8099 8443
CMD ["python", "start.py"]
