FROM python:3.11-slim

# Runtime invariant (GOCLAW/SSHDeck operations): the image must carry the
# diagnostics and migration tools used by the deployed service and its gates.
# Keep the install in the image (not on the host) and remove apt metadata so
# the runtime remains deterministic and compact.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm postgresql-client \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.source=https://github.com/nguyenha935/SSHDeck
LABEL org.opencontainers.image.description="SSHDeck - A modern web-based SSH client with SFTP file manager"
LABEL org.opencontainers.image.licenses=PolyForm-Noncommercial-1.0.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5000 \
    DATA_DIR=/app/data

WORKDIR /app

RUN adduser --disabled-password --gecos "" appuser

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

RUN chown -R appuser:appuser /app && \
    mkdir -p /app/data/logs /app/data/keys && \
    chown -R appuser:appuser /app/data && \
    chmod 700 /app/data && \
    chmod 700 /app/data/logs && \
    chmod 700 /app/data/keys

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Persist the data dir (SQLite DB, encrypted keys, auto-generated SECRET_KEY).
# Auto-creates an anonymous volume on `docker run` so state survives restarts;
# override with a named/bind volume (see docker-compose.yml) for real durability.
VOLUME /app/data

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, socket; s=socket.create_connection(('127.0.0.1', int(os.getenv('PORT','5000'))), 2); s.close()"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["gunicorn", "--worker-class", "eventlet", "-w", "1", "--bind", "0.0.0.0:5000", "start:app"]
