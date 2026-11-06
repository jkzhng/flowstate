"""HTTP API over the flowstate engine.

Run locally:  .venv/Scripts/python -m uvicorn src.api.app:create_app --factory --reload --port 8100
Docs:         http://127.0.0.1:8100/docs
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import asdict
from functools import lru_cache
from typing import Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from src.analysis import compare_results, n_minus_1
from src.dc_opf import OpfError, run_dc_opf
from src.dc_power_flow import run_dc_power_flow
from src.matpower import CASES_DIR
from src.matrices import DcModel
from src.scenario import Scenario, ScenarioError, UnknownCaseError, apply_scenario, base_network
from src.api.store import Store

DEFAULT_DB = os.environ.get("FLOWSTATE_DB", str(CASES_DIR.parent / "data" / "flowstate.db"))
DEV_ORIGINS = ["http://localhost:5180", "http://127.0.0.1:5180"]  # Vite dev server


# --------------------------------------------------------------------------- request bodies

class SolveRequest(BaseModel):
    scenario: Scenario
    mode: Literal["opf", "pf"] = "opf"


class CompareRequest(BaseModel):
    scenario: Scenario
    base: Optional[Scenario] = None  # defaults to the unedited base case
    top_n: int = Field(10, ge=1, le=500)


class ContingencyRequest(BaseModel):
    scenario: Scenario
    branch_ids: Optional[list[str]] = None  # default: every in-service branch
    overload_threshold_percent: float = Field(100.0, gt=0)


class TransferRequest(BaseModel):
    scenario: Scenario
    source_bus: int
    sink_bus: int


class LayoutBody(BaseModel):
    positions: dict[str, dict[str, float]]  # bus_id -> {"x": .., "y": ..}


# --------------------------------------------------------------------------- helpers

def to_json(obj):
    """Make engine output JSON-safe: NaN/inf -> null, numpy scalars -> Python, int keys -> str."""
    if isinstance(obj, dict):
        return {str(k): to_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_json(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def case_id_from_stem(stem: str) -> str:
    m = re.fullmatch(r"pglib_opf_(case\d+)_ieee", stem)
    return m.group(1) if m else stem


def solve(scenario: Scenario, mode: str = "opf") -> tuple:
    network = apply_scenario(scenario)
    model = DcModel(network)
    result = run_dc_opf(network, model=model) if mode == "opf" else run_dc_power_flow(network, model=model)
    return network, model, result


@lru_cache(maxsize=16)
def _base_opf(case_id: str) -> dict:
    return solve(Scenario(base_case=case_id))[2]


# --------------------------------------------------------------------------- app

def create_app(db_path: str = DEFAULT_DB) -> FastAPI:
    app = FastAPI(title="Flowstate", version="0.2.0")
    app.state.store = Store(db_path)
    app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(ScenarioError)
    def _scenario_error(_: Request, exc: ScenarioError):
        status = 404 if isinstance(exc, UnknownCaseError) else 422
        return JSONResponse(status_code=status, content={
            "detail": {"kind": "invalid_scenario", "message": str(exc), "edit_index": exc.edit_index}})

    @app.exception_handler(OpfError)
    def _opf_error(_: Request, exc: OpfError):
        return JSONResponse(status_code=422, content={"detail": {"kind": "infeasible", "message": str(exc)}})

    @app.get("/health")
    def health():
        return {"status": "ok"}

    # ---- cases
    @app.get("/cases")
    def list_cases():
        out = []
        for path in sorted(CASES_DIR.glob("*.m")):
            cid = case_id_from_stem(path.stem)
            net = base_network(cid)
            out.append({
                "id": cid,
                "file": path.name,
                "n_buses": len(net.buses),
                "n_generators": len(net.generators),
                "n_branches": len(net.branches),
            })
        return sorted(out, key=lambda c: c["n_buses"])

    @app.get("/cases/{case_id}")
    def get_case(case_id: str):
        net = base_network(case_id)
        return to_json({
            "id": case_id,
            "name": net.name,
            "base_mva": net.base_mva,
            "reference_bus_id": net.reference_bus_id,
            "buses": [asdict(b) for b in net.buses],
            "generators": [asdict(g) for g in net.generators],
            "branches": [asdict(b) for b in net.branches],
            "layout": app.state.store.get_layout(case_id),
        })

    @app.put("/cases/{case_id}/layout")
    def put_layout(case_id: str, body: LayoutBody):
        net = base_network(case_id)
        unknown = [k for k in body.positions if not k.isdigit() or int(k) not in net.bus_index]
        if unknown:
            raise HTTPException(422, f"Unknown bus IDs in layout: {unknown[:10]}")
        app.state.store.put_layout(case_id, body.positions)
        return {"case_id": case_id, "n_positions": len(body.positions)}

    # ---- studies
    @app.post("/solve")
    def solve_endpoint(req: SolveRequest):
        _, _, result = solve(req.scenario, req.mode)
        return to_json({"mode": req.mode, **result})

    @app.post("/compare")
    def compare_endpoint(req: CompareRequest):
        if req.base is None:
            base = _base_opf(req.scenario.base_case)
        else:
            base = solve(req.base)[2]
        scenario = solve(req.scenario)[2]
        return to_json({
            "base": base,
            "scenario": scenario,
            "diff": compare_results(base, scenario, top_n=req.top_n),
        })

    @app.post("/contingency")
    def contingency_endpoint(req: ContingencyRequest):
        _, model, result = solve(req.scenario)
        flows = np.array([f["flow_mw"] for f in result["line_flows"]])
        try:
            screen = n_minus_1(model, flows, req.branch_ids, req.overload_threshold_percent)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        return to_json(screen)

    @app.post("/transfer")
    def transfer_endpoint(req: TransferRequest):
        """Flow change on every branch for a 1 MW source->sink transfer (the FTR path's PTDF)."""
        network = apply_scenario(req.scenario)
        for b in (req.source_bus, req.sink_bus):
            if b not in network.bus_index:
                raise HTTPException(422, f"Unknown bus {b}")
        if req.source_bus == req.sink_bus:
            raise HTTPException(422, "Source and sink must differ.")
        model = DcModel(network)
        try:
            ptdf = model.transfer_ptdf(req.source_bus, req.sink_bus)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        return to_json({"source_bus": req.source_bus, "sink_bus": req.sink_bus,
                        "ptdf": dict(zip(model.branch_ids, ptdf.tolist()))})

    # ---- saved scenarios
    @app.get("/scenarios")
    def list_scenarios(base_case: Optional[str] = None):
        return app.state.store.list_scenarios(base_case)

    @app.post("/scenarios", status_code=201)
    def create_scenario(scenario: Scenario):
        apply_scenario(scenario)  # reject scenarios that don't apply cleanly
        return app.state.store.create_scenario(scenario.model_dump())

    @app.get("/scenarios/{sid}")
    def get_scenario(sid: str):
        row = app.state.store.get_scenario(sid)
        if row is None:
            raise HTTPException(404, "Scenario not found")
        return row

    @app.put("/scenarios/{sid}")
    def update_scenario(sid: str, scenario: Scenario):
        apply_scenario(scenario)
        row = app.state.store.update_scenario(sid, scenario.model_dump())
        if row is None:
            raise HTTPException(404, "Scenario not found")
        return row

    @app.delete("/scenarios/{sid}", status_code=204)
    def delete_scenario(sid: str):
        if not app.state.store.delete_scenario(sid):
            raise HTTPException(404, "Scenario not found")

    return app

