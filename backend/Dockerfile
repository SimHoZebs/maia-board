FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS frontend-build

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.27-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b AS build

WORKDIR /src
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/maia-board .

FROM golang:1.27-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b AS stockfish-build
WORKDIR /stockfish
RUN curl -fL --retry 3 https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_19.tar.gz -o source.tar.gz \
    && echo '519b653d0d1ffb96531d982ccbe5c6a19425e8388e0e3c2f70f34b424ab32d76  source.tar.gz' | sha256sum -c - \
    && tar -xzf source.tar.gz --strip-components=1 \
    && make -C src net \
    && echo '1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2  src/nn-1a298aa575a0.nnue' | sha256sum -c - \
    && make -C src -j2 build ARCH=x86-64 \
    && make -C src strip

FROM python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6

ARG MAIA3_REF=1e13597c42d4858b7cfd7cfdae01e297263364b2
ENV HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface/hub \
    PYTHONUNBUFFERED=1

COPY backend/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch>=2,<3" \
    && python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && python -m pip install --no-cache-dir --no-deps \
      "https://github.com/CSSLab/maia3/archive/${MAIA3_REF}.tar.gz#sha256=774c363dd2f2d10d6996ef5ef0bdba473ae769a79e442132bd82d0e999b7b488"

WORKDIR /app
COPY --from=build /out/maia-board /app/maia-board
COPY backend/maia3_worker.py /app/maia3_worker.py
COPY backend/stockfish_worker.py /app/stockfish_worker.py
COPY backend/openings_lookup.py /app/openings_lookup.py
COPY backend/openings_table.json /app/openings_table.json
COPY --from=stockfish-build /stockfish/src/stockfish /app/stockfish
COPY --from=stockfish-build /stockfish/Copying.txt /app/licenses/stockfish-COPYING
COPY --from=stockfish-build /stockfish/source.tar.gz /app/licenses/stockfish-sf_19-source.tar.gz
COPY backend/STOCKFISH.md /app/licenses/STOCKFISH.md
COPY --from=frontend-build /frontend/dist /app/static

EXPOSE 8080
ENTRYPOINT ["/app/maia-board"]
