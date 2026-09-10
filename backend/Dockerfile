FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS frontend-build

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS build

WORKDIR /src
COPY backend/ ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -o /out/maia-board .

FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

ARG MAIA3_REF=1e13597c42d4858b7cfd7cfdae01e297263364b2
ENV HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface/hub \
    PYTHONUNBUFFERED=1

COPY backend/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch==2.14.0+cpu" \
    && python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && python -m pip install --no-cache-dir --no-deps \
      "https://github.com/CSSLab/maia3/archive/${MAIA3_REF}.tar.gz#sha256=774c363dd2f2d10d6996ef5ef0bdba473ae769a79e442132bd82d0e999b7b488"

WORKDIR /app
COPY --from=build /out/maia-board /app/maia-board
COPY backend/maia3_worker.py /app/maia3_worker.py
COPY --from=frontend-build /frontend/dist /app/static

EXPOSE 8080
ENTRYPOINT ["/app/maia-board"]
