# Heavy parsing container. Same image for local Docker and Cloudflare Containers (paid plan, later).
#   docker compose up heavy            # pypdfium2 only (~200 MB)
#   INSTALL_DOCLING=1 docker compose build heavy   # adds Docling layout/table/formula parsing (~2 GB)
FROM python:3.12-slim

ARG INSTALL_DOCLING=0
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1

WORKDIR /srv
COPY requirements.txt requirements-docling.txt ./
RUN pip install -r requirements.txt \
 && if [ "$INSTALL_DOCLING" = "1" ]; then pip install -r requirements-docling.txt; fi

COPY app ./app
COPY schema ./schema

RUN useradd --system --uid 10001 heavy
USER heavy

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
