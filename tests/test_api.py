import json

import httpx
import pytest
from fastapi.testclient import TestClient

from server.main import app
from server.domain.engine import load_dataset


@pytest.fixture(autouse=True)
def no_external_llm(monkeypatch):
    for name in ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_JSON_MODE"]:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def test_api_contract(client):
    assert client.get("/api/health").json()["status"] == "ok"
    config = client.get("/api/config").json()
    assert config["budget"] == 100
    assert config["baseline"]["score"] == pytest.approx(52.55768)
    response = client.post("/api/simulate", json={"decisions": config["example"]})
    assert response.status_code == 200
    assert response.json()["score"] == pytest.approx(56.54307)
    invalid = client.post("/api/simulate", json={"decisions": []}).json()
    assert invalid["score"] is None and not invalid["valid"]
    assert client.post("/api/analyze", json={"decisions": []}).status_code == 422


@pytest.mark.parametrize("body", [{"decisions": None}, {"decisions": [{"measure_id": 1}]}, {"decisions": [], "score": 100}, {"decisions": load_dataset()["example"] * 5}])
def test_reject_malformed_input(client, body):
    assert client.post("/api/simulate", json=body).status_code == 422


def test_no_credentials_returns_honest_fallback(client):
    response = client.post("/api/analyze", json={"decisions": load_dataset()["example"]})
    assert response.status_code == 200
    report = response.json()
    assert report["mode"] == "rules"
    assert "ИИ не подключён" in report["notice"]
    assert "56.54" in report["facts"]["overall"]


def fake_llm(monkeypatch, report, status=200):
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setenv("LLM_MODEL", "city-analyst")
    monkeypatch.setenv("LLM_API_KEY", "test-only-key")

    def handler(request):
        assert str(request.url) == "http://llm.test/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer test-only-key"
        payload = json.loads(request.content)
        assert payload["model"] == "city-analyst"
        assert "56.54" in payload["messages"][1]["content"]
        return httpx.Response(status, json={"choices": [{"message": {"content": json.dumps(report)}}]})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))


def good_report():
    return {"summary": "Сценарий улучшает положение слабого района.",
            "strengths": [{"text": "Социальные меры сокращают дефициты.", "fact_ids": ["district_nura"]}],
            "risks": [{"text": "Результат ограничен условиями учебной модели.", "fact_ids": ["limits"]}],
            "recommendation_ids": []}


def test_llm_returns_grounded_report(client, monkeypatch):
    fake_llm(monkeypatch, good_report())
    response = client.post("/api/analyze", json={"decisions": load_dataset()["example"]}).json()
    assert response["mode"] == "llm"
    assert response["report"]["summary"] == good_report()["summary"]


@pytest.mark.parametrize("failure", ["digits", "unknown_fact", "unknown_recommendation", "unavailable", "malformed"])
def test_bad_llm_response_cannot_override_calculated_result(client, monkeypatch, failure):
    report = good_report()
    if failure == "digits":
        report["summary"] = "Score вырос до 100."
    elif failure == "unknown_fact":
        report["strengths"][0]["fact_ids"] = ["invented"]
    elif failure == "unknown_recommendation":
        report["recommendation_ids"] = ["invented"]
    elif failure == "malformed":
        report = {}
    fake_llm(monkeypatch, report, 503 if failure == "unavailable" else 200)
    response = client.post("/api/analyze", json={"decisions": load_dataset()["example"]}).json()
    assert response["mode"] == "rules"
    assert "56.54" in response["facts"]["overall"]
