import json
import logging
import os
import re

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)


class GroundedText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=800)
    fact_ids: list[str] = Field(min_length=1, max_length=5)


class Report(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: str = Field(min_length=1, max_length=1000)
    strengths: list[GroundedText] = Field(min_length=1, max_length=4)
    risks: list[GroundedText] = Field(min_length=1, max_length=4)
    recommendation_ids: list[str] = Field(max_length=3)


def make_facts(result: dict, data: dict) -> dict[str, str]:
    districts = {d["id"]: d["name"] for d in data["districts"]}
    metrics = {m["id"]: m["name"] for m in data["metrics"]}
    measures = {m["id"]: m for m in data["measures"]}
    facts = {
        "overall": f"Score: {result['baseline_score']:.2f} → {result['score']:.2f}; изменение {result['score_delta']:+.2f}.",
        "budget": f"Потрачено {result['spent']} из {data['budget']}; остаток {result['remaining']} не даёт бонуса.",
        "weakest": f"Самый слабый район: {districts[result['weakest_district_id']]}; D = {result['minimum']:.2f}.",
        "critical": f"Критических показателей строго ниже {data['critical_threshold']}: {len(result['critical'])}.",
        "horizon": f"Горизонт модели: {data['horizon']} кварталов. Эффекты уменьшены с учётом лагов.",
        "limits": "Это синтетическая модель; результат не является прогнозом реального развития Астаны.",
    }
    for district in result["districts"]:
        changes = [f"{metrics[k]} {delta:+.2f}" for k, delta in district["deltas"].items() if delta]
        facts[f"district_{district['id']}"] = f"{district['name']}: D = {district['score']:.2f}. " + ("; ".join(changes) or "Показатели не изменились.")
    for contribution in result["contributions"]:
        measure = measures[contribution["measure_id"]]
        target = districts.get(contribution["district_id"], "весь город")
        facts[f"measure_{measure['id']}"] = f"{measure['name']}, {target}: вклад в Score {contribution['score_delta']:+.3f}, стоимость {measure['cost']}, лаг {measure['lag']} кварталов. Вклад рассчитан методом Шепли."
    for i, critical in enumerate(result["critical"]):
        facts[f"critical_{i}"] = f"{districts[critical['district_id']]}: {metrics[critical['metric_id']]} = {critical['value']:.2f}."
    for i, synergy in enumerate(result["synergies"]):
        facts[f"synergy_{i}"] = f"Синергия {' + '.join(synergy['pair'])}, {districts[synergy['district_id']]}: " + ", ".join(f"{metrics[k]} {v:+}" for k, v in synergy["effects"].items())
    for suggestion in result["suggestions"]:
        old, new = suggestion["remove"], suggestion["add"]
        facts[suggestion["id"]] = (f"Заменить {measures[old['measure_id']]['name']} ({districts.get(old['district_id'], 'город')}) "
                                    f"на {measures[new['measure_id']]['name']} ({districts.get(new['district_id'], 'город')}). "
                                    f"Score {suggestion['score']:.2f}, изменение {suggestion['score_delta']:+.2f}, стоимость набора {suggestion['spent']}. "
                                    "Валидность проверена. Это локальное улучшение одной заменой, не глобальный оптимум.")
    return facts


def fallback_report(result: dict) -> dict:
    best = max(result["contributions"], key=lambda c: c["score_delta"])
    return Report(
        summary="Расчёт готов. Оценка учитывает средний результат города, положение самого слабого района и критические показатели.",
        strengths=[GroundedText(text="Эта мера даёт наибольший вклад в изменение итоговой оценки среди выбранных мероприятий.", fact_ids=[f"measure_{best['measure_id']}", "overall"])],
        risks=[GroundedText(text="Проверьте оставшиеся дефициты и положение самого слабого района: они влияют на итоговую оценку.", fact_ids=["weakest", "critical"]),
               GroundedText(text="Эффекты отражают условный горизонт реализации; их нельзя воспринимать как прогноз для реального города.", fact_ids=["horizon", "limits"])],
        recommendation_ids=[s["id"] for s in result["suggestions"]],
    ).model_dump()


SYSTEM_PROMPT = """Ты — аналитик учебного симулятора управления Астаной. Пиши по-русски.
Полученные факты уже рассчитаны сервером. Не вычисляй, не меняй и не придумывай числа.
В текстах summary и text не используй цифры, количественные утверждения или числительные:
интерфейс отдельно покажет исходные факты с точными числами по fact_ids.
Объясняй только подтверждённые фактами сильные стороны, ограничения, лаги и компромиссы.
Не приписывай мерам эффекты вне синтетической модели. Не обещай реальные результаты.
Рекомендации выбирай только из предоставленных option_*; они проверены сервером.
Верни только JSON без Markdown следующей структуры:
{"summary":"краткое объяснение", "strengths":[{"text":"сильная сторона","fact_ids":["overall"]}],
"risks":[{"text":"риск","fact_ids":["weakest"]}], "recommendation_ids":[]}
В strengths и risks от одного до четырёх пунктов. Каждый fact_id должен существовать.
"""


async def explain(result: dict, data: dict) -> dict:
    facts = make_facts(result, data)
    fallback = {"mode": "rules", "report": fallback_report(result), "facts": facts}
    base_url = os.getenv("LLM_BASE_URL", "").strip().rstrip("/")
    model = os.getenv("LLM_MODEL", "").strip()
    if not base_url or not model:
        return {**fallback, "notice": "ИИ не подключён. Показано объяснение по правилам модели."}
    headers = {}
    if key := os.getenv("LLM_API_KEY", ""):
        headers["Authorization"] = f"Bearer {key}"
    payload = {"model": model, "temperature": 0.2, "max_tokens": 1500,
               "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": json.dumps({"facts": facts}, ensure_ascii=False)}]}
    if os.getenv("LLM_JSON_MODE", "true").lower() == "true":
        payload["response_format"] = {"type": "json_object"}
    try:
        async with httpx.AsyncClient(timeout=35.0) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
            response.raise_for_status()
        report = Report.model_validate_json(response.json()["choices"][0]["message"]["content"])
        texts = [report.summary] + [item.text for item in report.strengths + report.risks]
        if any(re.search(r"\d", text) for text in texts):
            raise ValueError("LLM included numerical claims in prose")
        if any(ref not in facts for item in report.strengths + report.risks for ref in item.fact_ids):
            raise ValueError("LLM referenced unknown facts")
        allowed = {s["id"] for s in result["suggestions"]}
        if not set(report.recommendation_ids) <= allowed:
            raise ValueError("LLM invented recommendations")
        return {"mode": "llm", "notice": "ИИ объясняет рассчитанные сервером факты.",
                "report": report.model_dump(), "facts": facts}
    except (httpx.HTTPError, ValidationError, ValueError, KeyError, IndexError, TypeError):
        logger.warning("LLM response unavailable or failed validation; serving calculated explanation")
        return {**fallback, "notice": "ИИ временно недоступен или ответ не прошёл проверку. Показано объяснение по правилам модели."}
