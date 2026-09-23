from copy import deepcopy
from itertools import permutations

import pytest

from server.domain.engine import calculate, load_dataset, simulate, validate


@pytest.fixture
def data():
    return deepcopy(load_dataset())


def test_baseline_and_example(data):
    baseline = calculate([], data)
    assert [d["score"] for d in baseline["districts"]] == pytest.approx([62.99, 57.06, 54.65, 56.63, 49.18])
    assert baseline["average"] == pytest.approx(56.8624)
    assert baseline["score"] == pytest.approx(52.55768)
    assert len(baseline["critical"]) == 2
    response = simulate(data["example"], data)
    result = response["result"]
    assert response["valid"]
    assert result["spent"] == 95
    assert result["score"] == pytest.approx(56.54307)
    assert result["score_delta"] == pytest.approx(3.98539)
    assert result["critical"] == []
    nura = next(d for d in result["districts"] if d["id"] == "nura")
    assert nura["indicators"]["S1"] == 48
    assert nura["indicators"]["S2"] == 43.75
    assert nura["indicators"]["B1"] == 67.5
    assert result["synergies"][0]["pair"] == ["M10", "M12"]
    assert sum(c["score_delta"] for c in result["contributions"]) == pytest.approx(result["score_delta"])


def test_order_invariant(data):
    expected = calculate(data["example"], data)
    for decisions in permutations(data["example"]):
        assert calculate(list(decisions), data) == expected


@pytest.mark.parametrize("ids,targets,reason", [
    (["M7", "M8", "M10", "M12"], ["nura", "nura", "nura", None], "ровно"),
    (["M7", "M7", "M10", "M12", "M5"], ["nura", "esil", "nura", None, "saryarka"], "один раз"),
    (["M3", "M5", "M7", "M10", "M14"], ["esil", "saryarka", "nura", "nura", None], "бюджет"),
    (["M7", "M8", "M9", "M12", "M10"], ["nura", "nura", "esil", None, "nura"], "двух"),
    (["M1", "M3", "M9", "M11", "M12"], ["esil", "nura", "nura", "esil", None], "несовместимы"),
    (["M4", "M7", "M9", "M11", "M12"], ["nura", "nura", "esil", "esil", None], "участок"),
    (["M5", "M13", "M9", "M11", "M12"], ["nura", "nura", "esil", "esil", None], "дублируют"),
    (["M7", "M8", "M10", "M12", "M5"], [None, "nura", "nura", None, "saryarka"], "существующий"),
    (["M7", "M8", "M10", "M12", "M5"], ["nura", "nura", "nura", "esil", "saryarka"], "указывать нельзя"),
    (["UNKNOWN", "M8", "M10", "M12", "M5"], ["nura", "nura", "nura", None, "saryarka"], "Неизвестная"),
])
def test_invalid_sets_never_get_score(data, ids, targets, reason):
    decisions = [dict(measure_id=m, district_id=d) for m, d in zip(ids, targets)]
    response = simulate(decisions, data)
    assert not response["valid"]
    assert response["score"] is None
    assert response["result"] is None
    assert reason in " ".join(response["errors"])


def test_cheap_set_and_cross_district_conflict_allowed(data):
    cheap = [{"measure_id": m, "district_id": None if m == "M12" else "nura"}
             for m in ["M9", "M11", "M10", "M12", "M4"]]
    result = simulate(cheap, data)
    assert result["valid"] and result["result"]["spent"] == 61
    assert result["score"] != pytest.approx(simulate(data["example"], data)["score"])
    cross = [dict(measure_id=m, district_id=d) for m, d in
             [("M4", "esil"), ("M7", "nura"), ("M9", "nura"), ("M11", "esil"), ("M12", None)]]
    assert validate(cross, data) == []


def test_threshold_lags_negative_effects_and_clipping(data):
    baseline = calculate([], data)
    assert not any(c["value"] == 40 for c in baseline["critical"])
    m11 = calculate([{"measure_id": "M11", "district_id": "nura"}], data)
    nura = m11["districts"][-1]
    assert nura["indicators"]["T1"] == 53.25
    assert nura["indicators"]["B2"] == 60.5
    data["districts"][-1]["indicators"]["T1"] = 99
    decisions = [{"measure_id": "M2", "district_id": None}, {"measure_id": "M11", "district_id": "nura"}]
    # Clip only after adding +3 and -1.75. Sequential clipping would yield 98.25.
    assert calculate(decisions, data)["districts"][-1]["indicators"]["T1"] == 100
    data["districts"][-1]["indicators"]["T1"] = 0
    assert calculate([decisions[1]], data)["districts"][-1]["indicators"]["T1"] == 0


def test_suggestions_are_valid_and_improve(data):
    result = simulate(data["example"], data)["result"]
    assert result["suggestions"]
    for suggestion in result["suggestions"]:
        assert validate(suggestion["decisions"], data) == []
        assert calculate(suggestion["decisions"], data)["score"] == suggestion["score"]
        assert suggestion["score"] > result["score"]


def test_budget_boundary_is_inclusive(data):
    data["budget"] = 95
    assert validate(data["example"], data) == []
    data["budget"] = 94
    assert "бюджет" in " ".join(validate(data["example"], data))


def test_dataset_invariants(data):
    assert sum(m["weight"] for m in data["metrics"]) == pytest.approx(1)
    assert sum(d["population_share"] for d in data["districts"]) == pytest.approx(1)
    assert len(data["measures"]) == 14
    assert all(0 <= m["lag"] <= data["horizon"] for m in data["measures"])
    metric_ids = {m["id"] for m in data["metrics"]}
    assert all(set(d["indicators"]) == metric_ids for d in data["districts"])
    assert all(0 <= value <= 100 for d in data["districts"] for value in d["indicators"].values())
