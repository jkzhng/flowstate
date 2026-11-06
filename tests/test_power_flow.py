import pytest
import numpy as np

from src.dc_power_flow import solve_voltage_angles, calculate_line_flows
from data.default3 import BUSES, BRANCHES, BASE_MVA


def test_three_bus_line_flows():
    injections_mw = [100, 50, -150]

    theta = solve_voltage_angles(
        BUSES,
        BRANCHES,
        injections_mw,
        BASE_MVA,
        reference_bus_id=1,
    )

    flows = calculate_line_flows(
        BUSES, BRANCHES, theta, BASE_MVA
    )

    expected = {
        (1, 2): 13.6363636,
        (1, 3): 86.3636364,
        (2, 3): 63.6363636,
    }

    for flow in flows:
        key = (flow["from_bus"], flow["to_bus"])
        assert np.isclose(
            flow["flow_mw"], expected[key], atol=0.01
        )

def test_three_bus_opf_lmps_with_binding_line():
    from src.dc_opf import solve_dc_opf
    from src.models import Branch
    from data.default3 import BUSES, GENERATORS

    branches = [
        Branch(from_bus=1, to_bus=2, reactance_pu=0.10, limit_mw=100.0),
        Branch(from_bus=1, to_bus=3, reactance_pu=0.20, limit_mw=70.0),
        Branch(from_bus=2, to_bus=3, reactance_pu=0.25, limit_mw=100.0),
    ]
    r = solve_dc_opf(BUSES, GENERATORS, branches, BASE_MVA, reference_bus_id=1)

    assert r["total_cost"] == pytest.approx(7200.0, rel=1e-6)
    assert r["generation_mw"]["G1"] == pytest.approx(10.0, abs=1e-4)
    # Bus 3 is priced above both offers because serving it means backing down cheap G1
    for bus, price in {1: 20.0, 2: 50.0, 3: 125.0}.items():
        assert r["lmps"][bus] == pytest.approx(price, abs=1e-4)
    assert [c["branch_id"] for c in r["binding_constraints"]] == ["L2"]
