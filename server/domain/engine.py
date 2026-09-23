from collections import Counter
from functools import lru_cache
from itertools import combinations
from math import factorial
from pathlib import Path
import json


@lru_cache
def load_dataset() -> dict:
    return json.loads((Path(__file__).resolve().parents[2] / "data/scenario.json").read_text(encoding="utf-8"))


def validate(decisions: list[dict], data: dict) -> list[str]:
    errors = []
    measures = {m["id"]: m for m in data["measures"]}
    districts = {d["id"] for d in data["districts"]}
    if len(decisions) != data["decision_count"]:
        errors.append(f"Нужно выбрать ровно {data['decision_count']} мер. Сейчас: {len(decisions)}.")
    ids = [d["measure_id"] for d in decisions]
    if len(ids) != len(set(ids)):
        errors.append("Каждое мероприятие можно выбрать только один раз.")
    for decision in decisions:
        measure = measures.get(decision["measure_id"])
        if not measure:
            errors.append(f"Неизвестная мера: {decision['measure_id']}.")
            continue
        district = decision.get("district_id")
        if measure["scope"] == "district" and district not in districts:
            errors.append(f"Для {measure['id']} необходимо выбрать существующий район.")
        if measure["scope"] == "city" and district is not None:
            errors.append(f"Мера {measure['id']} действует на весь город: район указывать нельзя.")
    chosen = [measures[mid] for mid in ids if mid in measures]
    if sum(m["cost"] for m in chosen) > data["budget"]:
        errors.append(f"Превышен бюджет: доступно {data['budget']} единиц.")
    categories = Counter(m["category"] for m in chosen)
    if any(n > data["max_per_category"] for n in categories.values()):
        errors.append("Допустимо не более двух мер из одного направления.")
    targets = {d["measure_id"]: d.get("district_id") for d in decisions}
    for conflict in data["incompatibilities"]:
        a, b = conflict["pair"]
        if a in targets and b in targets:
            if conflict["scope"] == "city" or targets[a] == targets[b]:
                errors.append(conflict["reason"])
    return errors


def calculate(decisions: list[dict], data: dict) -> dict:
    """Internal calculator also accepts subsets for baseline and Shapley values.

    Call validate before exposing a user scenario's score. Add ALL effects before
    clipping, so order cannot affect results. Never round intermediate values.
    """
    measures = {m["id"]: m for m in data["measures"]}
    indicators = {d["id"]: dict(d["indicators"]) for d in data["districts"]}
    targets = {d["measure_id"]: d.get("district_id") for d in decisions}
    for decision in sorted(decisions, key=lambda d: d["measure_id"]):
        measure = measures[decision["measure_id"]]
        factor = (data["horizon"] - measure["lag"]) / data["horizon"]
        affected = indicators if measure["scope"] == "city" else [decision["district_id"]]
        for district_id in affected:
            for metric, effect in measure["effects"].items():
                indicators[district_id][metric] += effect * factor
    synergies = []
    for synergy in data["synergies"]:
        a, b = synergy["pair"]
        if a in targets and b in targets:
            district_id = targets[a]
            for metric, effect in synergy["effects"].items():
                indicators[district_id][metric] += effect
            synergies.append({**synergy, "district_id": district_id})
    districts = []
    critical = []
    for district in data["districts"]:
        values = {k: max(0, min(100, v)) for k, v in indicators[district["id"]].items()}
        score = sum(metric["weight"] * values[metric["id"]] for metric in data["metrics"])
        category_scores = {}
        for category in data["categories"]:
            metrics = [m for m in data["metrics"] if m["category"] == category["id"]]
            category_scores[category["id"]] = sum(m["weight"] * values[m["id"]] for m in metrics) / sum(m["weight"] for m in metrics)
        districts.append({"id": district["id"], "name": district["name"], "score": score,
                          "indicators": values, "category_scores": category_scores,
                          "deltas": {k: v - district["indicators"][k] for k, v in values.items()}})
        critical.extend({"district_id": district["id"], "metric_id": k, "value": v}
                        for k, v in values.items() if v < data["critical_threshold"])
    average = sum(d["population_share"] * result["score"] for d, result in zip(data["districts"], districts))
    weakest = min(districts, key=lambda d: d["score"])
    return {"score": 0.7 * average + 0.3 * weakest["score"] - len(critical),
            "average": average, "minimum": weakest["score"], "weakest_district_id": weakest["id"],
            "critical": critical, "districts": districts, "synergies": synergies}


def contributions(decisions: list[dict], data: dict) -> list[dict]:
    """Exact Shapley attribution: average marginal score over all decision orders.

    Distributes synergy, minimum-district changes and critical-threshold bonuses
    fairly, with contributions summing to total score improvement.
    """
    n = len(decisions)
    scores = {}
    for size in range(n + 1):
        for subset in combinations(range(n), size):
            scores[frozenset(subset)] = calculate([decisions[i] for i in subset], data)["score"]
    result = []
    for i, decision in enumerate(decisions):
        value = 0
        for subset, score in scores.items():
            if i not in subset:
                weight = factorial(len(subset)) * factorial(n - len(subset) - 1) / factorial(n)
                value += weight * (scores[subset | {i}] - score)
        result.append({**decision, "score_delta": value})
    return result


def suggestions(decisions: list[dict], data: dict, current_score: float) -> list[dict]:
    """Best strictly improving one-decision replacements; not a global optimum."""
    candidates = []
    seen = set()
    for index, old in enumerate(decisions):
        for measure in data["measures"]:
            targets = [None] if measure["scope"] == "city" else [d["id"] for d in data["districts"]]
            for target in targets:
                replacement = {"measure_id": measure["id"], "district_id": target}
                candidate = decisions[:index] + [replacement] + decisions[index + 1:]
                key = tuple(sorted((d["measure_id"], d.get("district_id") or "") for d in candidate))
                if key in seen or validate(candidate, data):
                    continue
                seen.add(key)
                score = calculate(candidate, data)["score"]
                if score > current_score + 1e-9:
                    candidates.append({"remove": old, "add": replacement, "score": score,
                                       "score_delta": score - current_score, "decisions": candidate,
                                       "spent": sum(next(m["cost"] for m in data["measures"] if m["id"] == d["measure_id"]) for d in candidate)})
    candidates.sort(key=lambda c: (-c["score"], c["spent"], c["add"]["measure_id"], c["add"]["district_id"] or ""))
    return [{"id": f"option_{i + 1}", **candidate} for i, candidate in enumerate(candidates[:3])]


def simulate(decisions: list[dict], data: dict | None = None) -> dict:
    data = data or load_dataset()
    errors = validate(decisions, data)
    if errors:
        return {"valid": False, "score": None, "errors": errors, "result": None}
    decisions = sorted(decisions, key=lambda d: (d["measure_id"], d.get("district_id") or ""))
    result = calculate(decisions, data)
    baseline = calculate([], data)
    prices = {m["id"]: m["cost"] for m in data["measures"]}
    spent = sum(prices[d["measure_id"]] for d in decisions)
    return {"valid": True, "score": result["score"], "errors": [],
            "result": {**result, "baseline_score": baseline["score"],
                       "score_delta": result["score"] - baseline["score"], "spent": spent,
                       "remaining": data["budget"] - spent, "decisions": decisions,
                       "contributions": contributions(decisions, data),
                       "suggestions": suggestions(decisions, data, result["score"]),
                       "dataset_version": data["version"]}}
