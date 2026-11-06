"""DC optimal power flow in PTDF (shift-factor) form.

    minimize    sum_g c2 pg^2 + c1 pg + c0
    subject to  sum of injections in each island = 0          (dual nu_k)
                -limit <= H (Cg pg - D) + f0 <= limit          (duals mu_dn, mu_up >= 0)
                pmin <= pg <= pmax

LMP at bus i = d(cost)/d(load_i) = energy_k(i) + congestion_i, with
    energy_k     = -nu_k
    congestion_i = -sum_l H[l, i] (mu_up_l - mu_dn_l)
(cvxpy reports duals as -d(objective)/d(rhs)). Losses are ignored, so LMP differences
within an island are purely congestion, which is the quantity an FTR settles on.
"""

from __future__ import annotations

import cvxpy as cp
import numpy as np

from src.dc_power_flow import bus_withdrawals_mw, format_flows
from src.matrices import DcModel
from src.models import Network

BINDING_TOL = 1e-3  # $/MWh; lines at their limit with a smaller shadow price don't affect prices


class OpfError(RuntimeError):
    pass


def run_dc_opf(network: Network, model: DcModel | None = None, solver: str = cp.CLARABEL) -> dict:
    model = model or DcModel(network)
    base = network.base_mva

    gens = [g for g in network.generators if g.in_service]
    ng = len(gens)
    gen_bus = np.array([network.bus_index[g.bus_id] for g in gens], dtype=int)
    demand = bus_withdrawals_mw(network)

    H = model.ptdf
    # flow = A @ pg + f0  (MW)
    A = H[:, gen_bus] if ng else np.zeros((model.nl, 0))
    f0 = -H @ (demand + model.Pbusinj * base) + model.Pfinj * base

    pg = cp.Variable(ng, name="pg")
    pmin = np.array([g.p_min_mw for g in gens])
    pmax = np.array([g.p_max_mw for g in gens])
    constraints = [pg >= pmin, pg <= pmax] if ng else []

    balance = {}  # island index -> constraint
    for k, island in enumerate(model.islands):
        members = set(island.tolist())
        in_island = [j for j in range(ng) if gen_bus[j] in members]
        island_demand = float(demand[island].sum())
        bus_list = [model.bus_ids[i] for i in island]
        where = f"Island with buses {bus_list[:10]}{'...' if len(bus_list) > 10 else ''}"
        if not in_island:
            if abs(island_demand) > 1e-9:
                raise OpfError(f"{where} has {island_demand:.1f} MW of demand and no generation.")
            continue
        cap_min, cap_max = pmin[in_island].sum(), pmax[in_island].sum()
        if island_demand > cap_max + 1e-9:
            raise OpfError(
                f"{where} has {island_demand:.1f} MW of demand but only {cap_max:.1f} MW of generation capacity."
            )
        if island_demand < cap_min - 1e-9:
            raise OpfError(
                f"{where} has {island_demand:.1f} MW of demand but {cap_min:.1f} MW of minimum generation."
            )
        c = cp.sum(pg[in_island]) == island_demand
        balance[k] = c
        constraints.append(c)

    lim_rows = np.flatnonzero(np.isfinite(model.limit_mw) & model.in_service)
    flow_lim = A[lim_rows] @ pg + f0[lim_rows] if ng else f0[lim_rows]
    up = flow_lim <= model.limit_mw[lim_rows]
    dn = -flow_lim <= model.limit_mw[lim_rows]
    if len(lim_rows):
        constraints += [up, dn]

    c2 = np.array([g.cost_c2 for g in gens])
    c1 = np.array([g.offer_price for g in gens])
    c0 = float(sum(g.cost_c0 for g in gens))
    objective = c1 @ pg + c0
    if np.any(c2 != 0):
        objective = objective + cp.sum(cp.multiply(c2, cp.square(pg)))

    problem = cp.Problem(cp.Minimize(objective), constraints)
    problem.solve(solver=solver)
    if problem.status not in (cp.OPTIMAL, cp.OPTIMAL_INACCURATE):
        hint = " (transmission limits cannot be met with available generation)" \
            if problem.status == cp.INFEASIBLE else ""
        raise OpfError(f"DC-OPF failed. Status: {problem.status}{hint}")

    pg_val = np.asarray(pg.value, dtype=float).reshape(-1) if ng else np.zeros(0)

    # Duals -> LMPs
    mu = np.zeros(model.nl)  # mu_up - mu_dn per branch
    if len(lim_rows):
        mu[lim_rows] = np.asarray(up.dual_value).reshape(-1) - np.asarray(dn.dual_value).reshape(-1)
    energy = np.full(model.nb, np.nan)
    for k, c in balance.items():
        energy[model.islands[k]] = -float(np.asarray(c.dual_value).reshape(-1)[0])
    congestion = -H.T @ mu
    lmp = energy + congestion

    # Flows and angles from the final dispatch
    injections = -demand.copy()
    np.add.at(injections, gen_bus, pg_val)
    theta = model.solve_angles(injections)
    flows = model.branch_flows_mw(theta)

    binding = [
        {
            "branch_id": model.branch_ids[l],
            "from_bus": network.branches[l].from_bus,
            "to_bus": network.branches[l].to_bus,
            "direction": "forward" if mu[l] > 0 else "reverse",
            "flow_mw": float(flows[l]),
            "limit_mw": float(model.limit_mw[l]),
            "shadow_price": float(abs(mu[l])),  # $/MWh saved per extra MW of capacity
        }
        for l in np.flatnonzero(np.abs(mu) > BINDING_TOL)
    ]
    binding.sort(key=lambda r: -r["shadow_price"])

    gen_out = {g.generator_id: 0.0 for g in network.generators}
    gen_out.update({g.generator_id: float(pg_val[j]) for j, g in enumerate(gens)})

    return {
        "status": problem.status,
        "total_cost": float(problem.value),
        "generation_mw": gen_out,
        "voltage_angles_rad": dict(zip(model.bus_ids, theta.tolist())),
        "line_flows": format_flows(network, model, flows),
        "lmps": dict(zip(model.bus_ids, lmp.tolist())),
        "lmp_energy": dict(zip(model.bus_ids, energy.tolist())),
        "lmp_congestion": dict(zip(model.bus_ids, congestion.tolist())),
        "binding_constraints": binding,
        "n_islands": model.n_islands,
    }


def solve_dc_opf(buses, generators, branches, base_mva, reference_bus_id=1):
    """Original list-based API, kept for existing callers."""
    network = Network(buses=buses, generators=generators, branches=branches,
                      base_mva=base_mva, reference_bus_id=reference_bus_id)
    return run_dc_opf(network)
