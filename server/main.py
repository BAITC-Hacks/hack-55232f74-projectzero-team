from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictStr

from server.domain.engine import calculate, load_dataset, simulate
from server.ai.analyst import explain


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    measure_id: StrictStr = Field(max_length=20)
    district_id: StrictStr | None = Field(default=None, max_length=30)


class Scenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decisions: list[Decision] = Field(max_length=20)


app = FastAPI(title="Аким на 5 часов", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)


@app.get("/api/health")
def health():
    return {"status": "ok", "dataset_version": load_dataset()["version"]}


@app.get("/api/config")
def config():
    data = load_dataset()
    return {**data, "baseline": calculate([], data)}


@app.post("/api/simulate")
def run_simulation(scenario: Scenario):
    return simulate([d.model_dump() for d in scenario.decisions])


@app.post("/api/analyze")
async def analyze(scenario: Scenario):
    simulation = simulate([d.model_dump() for d in scenario.decisions])
    if not simulation["valid"]:
        raise HTTPException(status_code=422, detail=simulation["errors"])
    return await explain(simulation["result"], load_dataset())
