import json
import time
from pathlib import Path

import jsonschema
from fastapi.testclient import TestClient

from app import main
from app.engines import parse_pdf

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "fixtures/pdfs/waves-mini.pdf"
SCHEMA = json.loads((Path(__file__).resolve().parents[1] / "schema/parsed-document.schema.json").read_text())


def test_pypdfium2_matches_schema_and_reads_bookmarks():
    doc = parse_pdf(FIXTURE.read_bytes())
    jsonschema.validate(doc, SCHEMA)
    assert doc["pageCount"] == 8
    assert len(doc["blocks"]) == 8
    assert doc["toc"][0]["level"] == 1
    assert any(t["level"] == 2 for t in doc["toc"])
    assert any("wave" in (b.get("text") or "").lower() for b in doc["blocks"])


def test_page_range_limits_pages():
    doc = parse_pdf(FIXTURE.read_bytes(), page_range=(2, 3))
    jsonschema.validate(doc, SCHEMA)
    assert [p["no"] for p in doc["pages"]] == [2, 3]
    assert doc["pageCount"] == 8


def test_job_posts_callback(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "_download", lambda url: FIXTURE.read_bytes())
    monkeypatch.setattr(main, "_callback", lambda req, payload: calls.append((req.callback_token, payload)))
    client = TestClient(main.app)
    res = client.post(
        "/jobs",
        json={"document_id": "doc_1", "pdf_url": "http://x/pdf", "callback_url": "http://x/cb", "callback_token": "tok", "engine": "pypdfium2"},
    )
    assert res.status_code == 202
    job_id = res.json()["job_id"]
    for _ in range(100):
        if client.get(f"/jobs/{job_id}").json()["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert client.get(f"/jobs/{job_id}").json()["status"] == "done"
    token, payload = calls[0]
    assert token == "tok" and payload["ok"] is True
    jsonschema.validate(payload["document"], SCHEMA)


def test_failure_is_reported(monkeypatch):
    calls = []

    def boom(url):
        raise ValueError("downloaded file is not a PDF")

    monkeypatch.setattr(main, "_download", boom)
    monkeypatch.setattr(main, "_callback", lambda req, payload: calls.append(payload))
    client = TestClient(main.app)
    job_id = client.post(
        "/jobs", json={"document_id": "doc_2", "pdf_url": "http://x", "callback_url": "http://x/cb", "callback_token": "t"}
    ).json()["job_id"]
    for _ in range(100):
        if client.get(f"/jobs/{job_id}").json()["status"] == "failed":
            break
        time.sleep(0.05)
    assert calls == [{"ok": False, "error": "downloaded file is not a PDF"}]


def test_unknown_engine_rejected():
    client = TestClient(main.app)
    res = client.post(
        "/jobs", json={"document_id": "d", "pdf_url": "u", "callback_url": "c", "callback_token": "t", "engine": "docling"}
    )
    assert res.status_code in (202, 400)
