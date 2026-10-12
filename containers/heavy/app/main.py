"""Heavy PDF parsing job runner.

Runs under Docker locally (HEAVY_URL=http://127.0.0.1:8090) and later as a Cloudflare Container.
Contract (see packages/parsers/src/heavy.ts):
  POST /jobs {document_id, pdf_url, callback_url, callback_token, engine, page_range}
    -> 202 {job_id}; the job downloads pdf_url, parses it and POSTs
       {ok, document?: ParsedDocument, error?} to callback_url with "Authorization: Bearer <callback_token>".
The output must validate against schema/parsed-document.schema.json (generated from packages/schema).
"""

from __future__ import annotations

import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .engines import parse_pdf

log = logging.getLogger("heavy")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

MAX_PDF_BYTES = int(os.environ.get("MAX_PDF_BYTES", str(300 * 1024 * 1024)))
WORKERS = int(os.environ.get("HEAVY_WORKERS", "1"))

app = FastAPI(title="study-coach heavy parser", version="0.1.0")
pool = ThreadPoolExecutor(max_workers=WORKERS)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


class JobRequest(BaseModel):
    document_id: str = Field(min_length=1, max_length=128)
    pdf_url: str
    callback_url: str
    callback_token: str = Field(min_length=1)
    engine: Literal["pypdfium2", "docling"] = "pypdfium2"
    page_range: Optional[tuple[int, int]] = None


def _set(job_id: str, **kw) -> None:
    with jobs_lock:
        jobs[job_id].update(kw)


def _download(url: str) -> bytes:
    with httpx.Client(timeout=httpx.Timeout(60.0, read=300.0), follow_redirects=False) as client:
        with client.stream("GET", url) as res:
            res.raise_for_status()
            buf = bytearray()
            for chunk in res.iter_bytes():
                buf.extend(chunk)
                if len(buf) > MAX_PDF_BYTES:
                    raise ValueError("PDF exceeds MAX_PDF_BYTES")
    if not bytes(buf[:5]) == b"%PDF-":
        raise ValueError("downloaded file is not a PDF")
    return bytes(buf)


def _callback(req: JobRequest, payload: dict) -> None:
    headers = {"authorization": f"Bearer {req.callback_token}"}
    last: Exception | None = None
    for _ in range(3):
        try:
            res = httpx.post(req.callback_url, json=payload, headers=headers, timeout=60.0)
            if res.status_code < 500:
                if res.status_code >= 400:
                    log.error("callback rejected %s: %s", res.status_code, res.text[:300])
                return
            last = RuntimeError(f"callback HTTP {res.status_code}")
        except httpx.HTTPError as e:  # retry transient network errors
            last = e
    raise RuntimeError(f"callback failed: {last}")


def _run(job_id: str, req: JobRequest) -> None:
    _set(job_id, status="running")
    try:
        pdf = _download(req.pdf_url)
        doc = parse_pdf(pdf, engine=req.engine, page_range=req.page_range)
        _callback(req, {"ok": True, "document": doc})
        _set(job_id, status="done", pages=doc["pageCount"])
    except Exception as e:  # report every failure to the Workflow instead of leaving it waiting
        log.exception("job %s failed", job_id)
        _set(job_id, status="failed", error=str(e)[:500])
        try:
            _callback(req, {"ok": False, "error": str(e)[:500]})
        except Exception:
            log.exception("job %s: failure callback also failed", job_id)


@app.get("/health")
def health() -> dict:
    from .engines import available_engines

    return {"ok": True, "engines": available_engines()}


@app.post("/jobs", status_code=202)
def create_job(req: JobRequest) -> dict:
    from .engines import available_engines

    if req.engine not in available_engines():
        raise HTTPException(400, f"engine {req.engine} is not installed in this image")
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    with jobs_lock:
        jobs[job_id] = {"status": "queued", "document_id": req.document_id}
    pool.submit(_run, job_id, req)
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job
