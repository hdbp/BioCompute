# Containerized API for evaluation / UI development. Production execution runs natively
# (see docs/deployment.md) because Nextflow needs host Java, container runtime and data.
FROM python:3.12-slim
RUN useradd --system --create-home --uid 10001 biocompute
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ /app/backend/
COPY examples/ /app/examples/
USER biocompute
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--proxy-headers"]
