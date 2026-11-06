from __future__ import annotations

import numpy as np

from src.matrices import DcModel
from src.models import Network


def bus_withdrawals_mw(network: Network) -> np.ndarray:
    """Fixed demand at each bus: load plus shunt conductance (consumes Gs MW at 1 pu voltage)."""
    return np.array([b.load_mw + b.shunt_mw for b in network.buses], dtype=float)


def generation_by_bus_mw(network: Network, dispatch: dict[str, float] | None = None) -> np.ndarray:
    pg = np.zeros(len(network.buses))
    for g in network.generators:
        if g.in_service:
            p = g.p_mw if dispatch is None else dispatch.get(g.generator_id, 0.0)
            pg[network.bus_index[g.bus_id]] += p
    return pg


def run_dc_power_flow(
    network: Network,
    injections_mw=None,
    model: DcModel | None = None,
) -> dict:
    """DC power flow.

    Uses generator setpoints (`Generator.p_mw`) minus fixed demand unless `injections_mw`
    (one value per bus, in bus order) is given. Any imbalance in each island is picked up by
    that island's reference (slack) bus.
    """
    model = model or DcModel(network)

    if injections_mw is None:
        p = generation_by_bus_mw(network) - bus_withdrawals_mw(network)
    else:
        p = np.asarray(injections_mw, dtype=float)
        if p.shape != (model.nb,):
            raise ValueError("One injection is required per bus.")

    theta = model.solve_angles(p)
    flows = model.branch_flows_mw(theta)
    actual = model.bus_injections_mw(theta)

    slack = {}
    for k, ref in enumerate(model.island_refs):
        slack[network.buses[ref].bus_id] = float(actual[ref] - p[ref])

    return {
        "voltage_angles_rad": dict(zip(model.bus_ids, theta.tolist())),
        "injections_mw": dict(zip(model.bus_ids, actual.tolist())),
        "slack_mw": slack,
        "line_flows": format_flows(network, model, flows),
        "n_islands": model.n_islands,
    }


def format_flows(network: Network, model: DcModel, flows_mw: np.ndarray) -> list[dict]:
    out = []
    for k, br in enumerate(network.branches):
        flow = float(flows_mw[k])
        limited = br.is_limited
        out.append({
            "branch_id": br.branch_id,
            "from_bus": br.from_bus,
            "to_bus": br.to_bus,
            "in_service": br.in_service,
            "flow_mw": flow,
            "limit_mw": br.limit_mw if limited else None,
            "loading_percent": abs(flow) / br.limit_mw * 100 if limited else None,
            "is_overloaded": bool(limited and abs(flow) > br.limit_mw * (1 + 1e-9)),
        })
    return out


# ---------------------------------------------------------------------------
# Original list-based API, kept for existing callers.

def _network(buses, branches, base_mva, reference_bus_id):
    return Network(buses=buses, generators=[], branches=branches,
                   base_mva=base_mva, reference_bus_id=reference_bus_id)


def solve_voltage_angles(buses, branches, injections_mw, base_mva, reference_bus_id):
    p = np.asarray(injections_mw, dtype=float)
    if len(p) != len(buses):
        raise ValueError("One injection is required per bus.")
    if not np.isclose(p.sum(), 0.0, atol=1e-6):
        raise ValueError("Net power injections must sum to zero.")
    model = DcModel(_network(buses, branches, base_mva, reference_bus_id))
    return model.solve_angles(p)


def calculate_line_flows(buses, branches, theta, base_mva):
    network = _network(buses, branches, base_mva, None)
    model = DcModel(network)
    return format_flows(network, model, model.branch_flows_mw(np.asarray(theta, dtype=float)))
