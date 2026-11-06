"""Golden tests: our DC power flow / DC-OPF against PYPOWER (a port of MATPOWER) on pglib IEEE cases."""

import copy
import math

import numpy as np
import pytest

from src.dc_opf import OpfError, run_dc_opf
from src.dc_power_flow import run_dc_power_flow
from src.matpower import CASES_DIR, network_from_mpc, parse_matpower
from src.matrices import DcModel
from src.models import Network

pypower = pytest.importorskip("pypower.api")

# name -> (buses, generators, branches)
CASES = {
    "pglib_opf_case14_ieee": (14, 5, 20),
    "pglib_opf_case30_ieee": (30, 6, 41),
    "pglib_opf_case57_ieee": (57, 7, 80),
    "pglib_opf_case118_ieee": (118, 54, 186),
    "pglib_opf_case300_ieee": (300, 69, 411),
}

# PYPOWER result column indices
VA, LAM_P, PG, PF = 8, 13, 1, 13

PPOPT = pypower.ppoption(VERBOSE=0, OUT_ALL=0)


@pytest.fixture(scope="module", params=list(CASES))
def case(request):
    mpc = parse_matpower((CASES_DIR / f"{request.param}.m").read_text())
    network = network_from_mpc(mpc, name=request.param)
    return request.param, mpc, network


def test_parse_counts(case):
    name, _, net = case
    assert (len(net.buses), len(net.generators), len(net.branches)) == CASES[name]
    ids = [b.branch_id for b in net.branches]
    assert len(set(ids)) == len(ids)


def test_dc_power_flow_matches_pypower(case):
    _, mpc, net = case
    ref, ok = pypower.rundcpf(copy.deepcopy(mpc), PPOPT)
    assert ok

    ours = run_dc_power_flow(net)
    flows = np.array([f["flow_mw"] for f in ours["line_flows"]])
    np.testing.assert_allclose(flows, ref["branch"][:, PF], atol=1e-6)

    ref_va = np.deg2rad(ref["bus"][:, VA])
    ref_va -= ref_va[net.bus_index[net.reference_bus_id]]
    np.testing.assert_allclose(list(ours["voltage_angles_rad"].values()), ref_va, atol=1e-8)


@pytest.fixture(scope="module")
def opf_pair(case):
    _, mpc, net = case
    ref = pypower.rundcopf(copy.deepcopy(mpc), PPOPT)
    assert ref["success"]
    return net, ref, run_dc_opf(net)


def test_dc_opf_cost_and_dispatch(opf_pair):
    net, ref, ours = opf_pair
    assert ours["total_cost"] == pytest.approx(ref["f"], rel=1e-6)
    np.testing.assert_allclose(list(ours["generation_mw"].values()), ref["gen"][:, PG], atol=1e-2)


def test_dc_opf_flows_and_lmps(opf_pair):
    net, ref, ours = opf_pair
    flows = np.array([f["flow_mw"] for f in ours["line_flows"]])
    np.testing.assert_allclose(flows, ref["branch"][:, PF], atol=1e-2)
    np.testing.assert_allclose(list(ours["lmps"].values()), ref["bus"][:, LAM_P], atol=1e-3)

    for f in ours["line_flows"]:
        if f["limit_mw"] is not None:
            assert abs(f["flow_mw"]) <= f["limit_mw"] * (1 + 1e-6)


def test_some_cases_are_congested():
    # Guards against the LMP checks above being vacuous (uniform prices everywhere).
    congested = 0
    for name in ("pglib_opf_case118_ieee", "pglib_opf_case300_ieee"):
        net = network_from_mpc(parse_matpower((CASES_DIR / f"{name}.m").read_text()))
        result = run_dc_opf(net)
        lmps = np.array(list(result["lmps"].values()))
        if result["binding_constraints"] and np.ptp(lmps) > 0.01:
            congested += 1
    assert congested >= 1


def test_ptdf_reproduces_power_flow(case):
    _, _, net = case
    model = DcModel(net)
    pf = run_dc_power_flow(net, model=model)
    inj = np.array(list(pf["injections_mw"].values()))
    flows = model.ptdf @ (inj - model.Pbusinj * net.base_mva) + model.Pfinj * net.base_mva
    expected = np.array([f["flow_mw"] for f in pf["line_flows"]])
    np.testing.assert_allclose(flows, expected, atol=1e-6)


def test_lodf_matches_resolve(case):
    _, _, net = case
    model = DcModel(net)
    base = run_dc_power_flow(net, model=model)
    base_flows = np.array([f["flow_mw"] for f in base["line_flows"]])
    bridges = set(model.bridges)

    candidates = [b.branch_id for b in net.branches if b.in_service and b.branch_id not in bridges]
    for branch_id in candidates[:: max(1, len(candidates) // 15)]:
        predicted = model.outage_flows_mw(base_flows, branch_id)

        outaged = copy.deepcopy(net)
        outaged.branch(branch_id).in_service = False
        # Same injections as the base case so the comparison isolates the topology change
        actual = run_dc_power_flow(outaged, injections_mw=list(base["injections_mw"].values()))
        actual_flows = np.array([f["flow_mw"] for f in actual["line_flows"]])
        np.testing.assert_allclose(predicted, actual_flows, atol=1e-6, err_msg=branch_id)


def test_bridge_outage_creates_island_and_opf_still_solves(case):
    _, _, net = case
    model = DcModel(net)
    assert model.n_islands == 1
    if not model.bridges:
        pytest.skip("no radial branches")

    solved = 0
    for branch_id in model.bridges:
        outaged = copy.deepcopy(net)
        outaged.branch(branch_id).in_service = False
        m = DcModel(outaged)
        assert m.n_islands == 2
        assert np.isnan(model.lodf[:, model.branch_ids.index(branch_id)]).all()
        try:
            result = run_dc_opf(outaged, model=m)
        except OpfError:
            continue  # e.g. stranded load with too little local generation
        assert result["n_islands"] == 2
        assert result["status"] == "optimal"
        solved += 1
    assert solved or len(model.bridges) < 3, "expected at least one radial outage to be feasible"


def test_unlimited_branches():
    net = network_from_mpc(parse_matpower((CASES_DIR / "pglib_opf_case14_ieee.m").read_text()))
    net.branches[0].limit_mw = math.inf
    assert not net.branches[0].is_limited
    run_dc_opf(net)


def test_parallel_branches_are_distinct():
    net = network_from_mpc(parse_matpower((CASES_DIR / "pglib_opf_case118_ieee.m").read_text()))
    pairs = {}
    for b in net.branches:
        pairs.setdefault(frozenset((b.from_bus, b.to_bus)), []).append(b.branch_id)
    parallel = [ids for ids in pairs.values() if len(ids) > 1]
    assert parallel, "case118 should contain parallel circuits"

    model = DcModel(net)
    ptdf = model.transfer_ptdf(net.branches[0].from_bus, net.branches[0].to_bus)
    assert ptdf.shape == (len(net.branches),)
