import math

import numpy as np
import pytest

from src.analysis import compare_results, n_minus_1
from src.dc_opf import run_dc_opf
from src.dc_power_flow import run_dc_power_flow
from src.matrices import DcModel
from src.scenario import Scenario, ScenarioError, UnknownCaseError, apply_scenario, base_network


def scen(*edits, case="case30"):
    return Scenario.model_validate({"base_case": case, "edits": list(edits)})


def test_base_case_is_not_mutated():
    apply_scenario(scen({"op": "set_branch_status", "branch_id": "L1", "in_service": False}))
    assert base_network("case30").branch("L1").in_service


def test_each_edit_type_applies():
    net = apply_scenario(scen(
        {"op": "set_branch_status", "branch_id": "L2", "in_service": False},
        {"op": "set_branch_params", "branch_id": "L3", "reactance_pu": 0.5, "limit_mw": 42},
        {"op": "set_branch_params", "branch_id": "L4", "unlimited": True},
        {"op": "add_branch", "from_bus": 1, "to_bus": 30, "reactance_pu": 0.2, "limit_mw": 50},
        {"op": "set_load", "bus_id": 7, "load_mw": 99},
        {"op": "set_generator", "generator_id": "G2", "p_max_mw": 10, "offer_price": 5},
        {"op": "scale_load", "factor": 1.1},
    ))
    assert not net.branch("L2").in_service
    assert (net.branch("L3").reactance_pu, net.branch("L3").limit_mw) == (0.5, 42)
    assert math.isinf(net.branch("L4").limit_mw)
    new = net.branches[-1]
    assert (new.branch_id, new.from_bus, new.to_bus) == ("L42", 1, 30)
    assert net.buses[net.bus_index[7]].load_mw == pytest.approx(108.9)
    g2 = next(g for g in net.generators if g.generator_id == "G2")
    assert (g2.p_max_mw, g2.offer_price) == (10, 5)


@pytest.mark.parametrize("edit, fragment", [
    ({"op": "set_branch_status", "branch_id": "L999", "in_service": False}, "unknown branch"),
    ({"op": "set_load", "bus_id": 12345, "load_mw": 1}, "unknown bus"),
    ({"op": "set_generator", "generator_id": "G1", "p_min_mw": 500, "p_max_mw": 10}, "exceeds"),
    ({"op": "add_branch", "from_bus": 1, "to_bus": 1, "reactance_pu": 0.1}, "must differ"),
])
def test_invalid_edits_report_index(edit, fragment):
    good = {"op": "scale_load", "factor": 1.0}
    with pytest.raises(ScenarioError) as e:
        apply_scenario(scen(good, edit))
    assert e.value.edit_index == 1
    assert fragment in str(e.value)


def test_unknown_case():
    with pytest.raises(UnknownCaseError):
        apply_scenario(Scenario(base_case="case9999"))


def test_relieving_a_constraint_removes_congestion():
    base = run_dc_opf(apply_scenario(scen()))
    assert base["binding_constraints"], "case30 is congested at base load"
    bid = base["binding_constraints"][0]["branch_id"]

    relieved = run_dc_opf(apply_scenario(scen({"op": "set_branch_params", "branch_id": bid, "unlimited": True})))
    diff = compare_results(base, relieved)
    assert bid in diff["no_longer_binding"]
    assert diff["total_cost_delta"] < 0
    assert np.ptp(list(relieved["lmps"].values())) < np.ptp(list(base["lmps"].values()))


def test_n_minus_1_matches_full_resolve():
    net = apply_scenario(scen())
    model = DcModel(net)
    opf = run_dc_opf(net, model=model)
    flows = np.array([f["flow_mw"] for f in opf["line_flows"]])
    screen = n_minus_1(model, flows)

    assert len(screen["contingencies"]) + len(screen["islanding_outages"]) == model.in_service.sum()
    assert set(screen["islanding_outages"]) == set(model.bridges)

    worst = screen["contingencies"][0]
    injections = -np.array([b.load_mw + b.shunt_mw for b in net.buses])
    for g in net.generators:
        injections[net.bus_index[g.bus_id]] += opf["generation_mw"][g.generator_id]
    outaged = apply_scenario(scen({"op": "set_branch_status", "branch_id": worst["outage_branch_id"], "in_service": False}))
    pf = run_dc_power_flow(outaged, injections_mw=injections)
    worst_flow = next(f for f in pf["line_flows"] if f["branch_id"] == worst["worst_branch_id"])
    assert worst_flow["loading_percent"] == pytest.approx(worst["max_loading_percent"], abs=1e-6)


def test_add_bus_with_generator_and_lines():
    """A cheap generator on a new bus tied in by two lines lowers cost and sets nearby prices."""
    base = run_dc_opf(apply_scenario(scen(case="case14")))
    edits = [
        {"op": "add_bus", "bus_id": 100, "load_mw": 5, "x": 10, "y": 20},
        {"op": "add_generator", "bus_id": 100, "p_max_mw": 50, "offer_price": 1.0, "generator_id": "GNEW"},
        {"op": "add_branch", "from_bus": 100, "to_bus": 4, "reactance_pu": 0.1, "branch_id": "LNEW1"},
        {"op": "add_branch", "from_bus": 100, "to_bus": 9, "reactance_pu": 0.1, "limit_mw": 30, "branch_id": "LNEW2"},
    ]
    net = apply_scenario(scen(*edits, case="case14"))
    assert net.buses[net.bus_index[100]].x == 10
    res = run_dc_opf(net)
    assert res["n_islands"] == 1
    assert res["generation_mw"]["GNEW"] > 5  # exports beyond its own bus (limits nearby may cap it)
    assert res["total_cost"] < base["total_cost"]
    assert res["lmps"][100] is not None and math.isfinite(res["lmps"][100])
    assert {f["branch_id"] for f in res["line_flows"]} >= {"LNEW1", "LNEW2"}


def test_unconnected_new_bus_is_its_own_unpriced_island():
    res = run_dc_opf(apply_scenario(scen({"op": "add_bus"}, case="case14")))
    assert res["n_islands"] == 2
    assert math.isnan(res["lmps"][15])  # auto ID = largest + 1


def test_unconnected_new_bus_with_load_is_infeasible():
    from src.dc_opf import OpfError
    with pytest.raises(OpfError, match="no generation"):
        run_dc_opf(apply_scenario(scen({"op": "add_bus", "load_mw": 10}, case="case14")))


@pytest.mark.parametrize("edits, match", [
    ([{"op": "add_bus", "bus_id": 3}], "already exists"),
    ([{"op": "add_generator", "bus_id": 999, "p_max_mw": 10}], "unknown bus"),
    ([{"op": "add_generator", "bus_id": 1, "p_max_mw": 10, "p_min_mw": 20}], "exceeds"),
    ([{"op": "add_generator", "bus_id": 1, "p_max_mw": 10, "generator_id": "G1"}], "already exists"),
])
def test_add_element_errors(edits, match):
    with pytest.raises(ScenarioError, match=match):
        apply_scenario(scen(*edits, case="case14"))
