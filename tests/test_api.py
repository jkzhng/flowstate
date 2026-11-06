import json

import pytest
from fastapi.testclient import TestClient

from src.api.app import create_app


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(str(tmp_path / "test.db")))


# L5 outage is feasible in case30 (L1, L2, L4 and L34 outages are not: limits cannot be met)
OUTAGE = {"op": "set_branch_status", "branch_id": "L5", "in_service": False}


def test_list_cases(client):
    cases = client.get("/cases").json()
    assert [c["id"] for c in cases] == ["case14", "case30", "case57", "case118", "case300"]
    assert cases[3]["n_branches"] == 186


def test_get_case_is_json_safe(client):
    r = client.get("/cases/case118")
    assert r.status_code == 200
    body = r.json()
    assert len(body["buses"]) == 118
    json.dumps(body, allow_nan=False)
    assert client.get("/cases/nope").status_code == 404


def test_solve_opf_and_pf(client):
    opf = client.post("/solve", json={"scenario": {"base_case": "case30"}}).json()
    assert opf["mode"] == "opf" and opf["status"] == "optimal"
    assert len(opf["lmps"]) == 30 and opf["binding_constraints"]

    pf = client.post("/solve", json={"scenario": {"base_case": "case30"}, "mode": "pf"}).json()
    assert len(pf["line_flows"]) == 41 and "lmps" not in pf


def test_islanded_buses_without_generation_return_null_lmps(client):
    # Bus 117 in case118 hangs off radial line L184 and has no generator; its OPF errors (load stranded).
    # Zero its load first so the island is feasible and its LMP is undefined (null, not NaN).
    scenario = {"base_case": "case118", "edits": [
        {"op": "set_load", "bus_id": 117, "load_mw": 0},
        {"op": "set_branch_status", "branch_id": "L184", "in_service": False},
    ]}
    r = client.post("/solve", json={"scenario": scenario})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_islands"] == 2 and body["lmps"]["117"] is None


def test_errors_are_structured(client):
    bad_edit = client.post("/solve", json={"scenario": {"base_case": "case30", "edits": [
        {"op": "set_load", "bus_id": 1, "load_mw": 0},
        {"op": "set_branch_status", "branch_id": "L999", "in_service": False}]}})
    assert bad_edit.status_code == 422
    assert bad_edit.json()["detail"]["edit_index"] == 1

    infeasible = client.post("/solve", json={"scenario": {"base_case": "case118", "edits": [
        {"op": "set_branch_status", "branch_id": "L184", "in_service": False}]}})
    assert infeasible.status_code == 422
    assert infeasible.json()["detail"]["kind"] == "infeasible"

    unknown_op = client.post("/solve", json={"scenario": {"base_case": "case30", "edits": [{"op": "explode"}]}})
    assert unknown_op.status_code == 422


def test_compare(client):
    r = client.post("/compare", json={"scenario": {"base_case": "case30", "edits": [OUTAGE]}}).json()
    assert {"base", "scenario", "diff"} <= r.keys()
    l1 = next(f for f in r["diff"]["flows"] if f["branch_id"] == "L5")
    assert l1["after_mw"] == 0 and l1["delta_mw"] == pytest.approx(-l1["before_mw"])
    assert l1["delta_abs_mw"] == pytest.approx(-abs(l1["before_mw"]))
    assert len(r["diff"]["top_flow_changes"]) == 10


def test_contingency(client):
    r = client.post("/contingency", json={"scenario": {"base_case": "case30"}}).json()
    assert r["contingencies"] and "islanding_outages" in r
    loadings = [c["max_loading_percent"] for c in r["contingencies"]]
    assert loadings == sorted(loadings, reverse=True)

    subset = client.post("/contingency", json={"scenario": {"base_case": "case30"}, "branch_ids": ["L1", "L2"]}).json()
    assert {c["outage_branch_id"] for c in subset["contingencies"]} == {"L1", "L2"}
    assert client.post("/contingency", json={"scenario": {"base_case": "case30"}, "branch_ids": ["L999"]}).status_code == 422


def test_transfer_ptdf(client):
    r = client.post("/transfer", json={"scenario": {"base_case": "case14"}, "source_bus": 1, "sink_bus": 14}).json()
    assert len(r["ptdf"]) == 20
    # 1 MW leaves bus 1: everything on branches out of bus 1 (L1: 1-2, L2: 1-5) sums to 1
    assert r["ptdf"]["L1"] + r["ptdf"]["L2"] == pytest.approx(1.0)


def test_scenario_crud(client):
    body = {"base_case": "case30", "name": "L1 out", "edits": [OUTAGE]}
    created = client.post("/scenarios", json=body)
    assert created.status_code == 201
    sid = created.json()["id"]

    assert client.get(f"/scenarios/{sid}").json()["scenario"]["edits"][0]["branch_id"] == "L5"
    updated = client.put(f"/scenarios/{sid}", json={**body, "name": "renamed"}).json()
    assert updated["scenario"]["name"] == "renamed"
    assert [s["id"] for s in client.get("/scenarios", params={"base_case": "case30"}).json()] == [sid]
    assert client.get("/scenarios", params={"base_case": "case14"}).json() == []

    bad = client.post("/scenarios", json={"base_case": "case30", "edits": [{**OUTAGE, "branch_id": "L999"}]})
    assert bad.status_code == 422

    assert client.delete(f"/scenarios/{sid}").status_code == 204
    assert client.get(f"/scenarios/{sid}").status_code == 404


def test_layout_roundtrip(client):
    assert client.get("/cases/case14").json()["layout"] is None
    positions = {"1": {"x": 0, "y": 0}, "2": {"x": 10, "y": 5}}
    assert client.put("/cases/case14/layout", json={"positions": positions}).status_code == 200
    assert client.get("/cases/case14").json()["layout"] == positions
    assert client.put("/cases/case14/layout", json={"positions": {"999": {"x": 0, "y": 0}}}).status_code == 422
