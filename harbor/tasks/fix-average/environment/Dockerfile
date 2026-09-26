FROM python:3.12-slim-bookworm

# Common installed-agent prerequisites are cached in the task image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY stats.py test_public.py ./
