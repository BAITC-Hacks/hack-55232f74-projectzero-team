FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /project
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
RUN useradd --create-home --uid 10001 simulator
COPY --chown=simulator:simulator server server
COPY --chown=simulator:simulator data data

FROM base AS development
COPY server/requirements-dev.txt server/requirements-dev.txt
RUN pip install --no-cache-dir -r server/requirements-dev.txt
COPY --chown=simulator:simulator tests tests
USER simulator
EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS runtime
USER simulator
EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
