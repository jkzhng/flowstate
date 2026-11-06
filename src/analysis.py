"""Higher-level studies built on the DC model: N-1 contingency screening and scenario comparison."""

from __future__ import annotations

import math

import numpy as np

from src.matrices import DcModel


def n_minus_1(model: DcModel, base_flows_mw: np.ndarray, branch_ids: list[str] | None = None,
              overload_threshold: float = 100.0) -> dict:
    """Screen single-branch outages using LODFs, starting from `base_flows_mw` (e.g. an OPF dispatch).

    Dispatch is held fixed (no re-dispatch), which is the standard security screen.
    Outages that split an island are reported separately rather than solved.
    """
    if branch_ids is None:
        outages = np.flatnonzero(model.in_service)
    else:
        lookup = {b: k for k, b in enumerate(model.branch_ids)}
        unknown = [b for b in branch_ids if b not in lookup]
        if unknown:
            raise ValueError(f"Unknown branches: {unknown}")
        outages = np.array([lookup[b] for b in branch_ids], dtype=int)

    limits = model.limit_mw
    limited = np.isfinite(limits) & model.in_service
    bridges = set(model.bridges)
    results, islanding = [], []

    for k in outages:
        bid = model.branch_ids[k]
        if not model.in_service[k]:
            continue
        if bid in bridges:
            islanding.append(bid)
            continue
        post = base_flows_mw + model.lodf[:, k] * base_flows_mw[k]
        post[k] = 0.0
        loading = np.full(model.nl, np.nan)
        loading[limited] = np.abs(post[limited]) / limits[limited] * 100
        loading[k] = np.nan
        over = np.flatnonzero(np.nan_to_num(loading, nan=0.0) > overload_threshold)
        worst = int(np.nanargmax(loading)) if np.any(~np.isnan(loading)) else None
        results.append({
            "outage_branch_id": bid,
            "max_loading_percent": float(loading[worst]) if worst is not None else None,
            "worst_branch_id": model.branch_ids[worst] if worst is not None else None,
            "overloads": [
                {"branch_id": model.branch_ids[l], "flow_mw": float(post[l]),
                 "limit_mw": float(limits[l]), "loading_percent": float(loading[l])}
                for l in over[np.argsort(-loading[over])]
            ],
        })

    results.sort(key=lambda r: -(r["max_loading_percent"] or 0.0))
    return {
        "contingencies": results,
        "islanding_outages": islanding,
        "n_violating": sum(1 for r in results if r["overloads"]),
        "overload_threshold_percent": overload_threshold,
    }


def compare_results(base: dict, scenario: dict, top_n: int = 10) -> dict:
    """Per-element differences between two OPF (or PF) results: scenario minus base."""
    base_flows = {f["branch_id"]: f for f in base["line_flows"]}
    flow_deltas = []
    for f in scenario["line_flows"]:
        b = base_flows.get(f["branch_id"])
        before = b["flow_mw"] if b else None
        flow_deltas.append({
            "branch_id": f["branch_id"],
            "before_mw": before,
            "after_mw": f["flow_mw"],
            "delta_mw": _diff(f["flow_mw"], before),  # signed, in the branch's from->to direction
            # change in how heavily the line is used, regardless of direction; what people usually mean
            "delta_abs_mw": _diff(abs(f["flow_mw"]), abs(before) if before is not None else 0.0),
            "before_loading_percent": b["loading_percent"] if b else None,
            "after_loading_percent": f["loading_percent"],
            "added": b is None,
        })

    lmp_deltas = []
    if "lmps" in base and "lmps" in scenario:
        for bus_id, after in scenario["lmps"].items():
            before = base["lmps"].get(bus_id)
            lmp_deltas.append({"bus_id": bus_id, "before": before, "after": after,
                               "delta": _diff(after, before)})

    def top(rows, key):
        ranked = [r for r in rows if r[key] is not None]
        return sorted(ranked, key=lambda r: -abs(r[key]))[:top_n]

    out = {
        "flows": flow_deltas,
        "lmps": lmp_deltas,
        "top_flow_changes": top(flow_deltas, "delta_abs_mw"),
        "top_lmp_changes": top(lmp_deltas, "delta"),
    }
    if "total_cost" in base and "total_cost" in scenario:
        out["total_cost_delta"] = scenario["total_cost"] - base["total_cost"]
    if "binding_constraints" in base and "binding_constraints" in scenario:
        before = {c["branch_id"] for c in base["binding_constraints"]}
        after = {c["branch_id"] for c in scenario["binding_constraints"]}
        out["newly_binding"] = sorted(after - before)
        out["no_longer_binding"] = sorted(before - after)
    return out


def _diff(a, b):
    if a is None or b is None or (isinstance(a, float) and math.isnan(a)) or (isinstance(b, float) and math.isnan(b)):
        return None
    return a - b
