FROM python:3.12-slim-bookworm
ARG BUILD_VERSION=0.2.6
ARG BUILD_ARCH=amd64
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.source="https://github.com/Qualified4/roadviewer-ha"
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 RV_DATA=/data/roadviewer RV_INGRESS_ONLY=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY schema /schema
COPY app /app
EXPOSE 8099
CMD ["gunicorn", "--bind", "0.0.0.0:8099", "--workers", "1", "--threads", "4", "--timeout", "180", "--access-logfile", "-", "server:app"]
