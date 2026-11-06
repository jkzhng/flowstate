"""Reader for MATPOWER case files (version 2), e.g. the pglib-opf IEEE cases."""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np

from src.models import Branch, Bus, Generator, Network

# Column indices (0-based) from the MATPOWER manual, Appendix B.
BUS_I, BUS_TYPE, PD, QD, GS, BS, BUS_AREA, VM, VA, BASE_KV = range(10)
GEN_BUS, PG, QG, QMAX, QMIN, VG, MBASE, GEN_STATUS, PMAX, PMIN = range(10)
F_BUS, T_BUS, BR_R, BR_X, BR_B, RATE_A, RATE_B, RATE_C, TAP, SHIFT, BR_STATUS = range(11)
MODEL, STARTUP, SHUTDOWN, NCOST, COST = range(5)
POLYNOMIAL = 2

_MATRIX_RE = re.compile(r"mpc\.(\w+)\s*=\s*\[(.*?)\];", re.DOTALL)
_CELL_RE = re.compile(r"mpc\.(\w+)\s*=\s*\{(.*?)\};", re.DOTALL)
_SCALAR_RE = re.compile(r"mpc\.(\w+)\s*=\s*([-+0-9.eE]+)\s*;")


def parse_matpower(text: str) -> dict:
    """Parse MATPOWER file text into a dict of numpy arrays (a PYPOWER-style 'ppc')."""
    text_no_comments = "\n".join(_strip_comment(line) for line in text.splitlines())

    mpc: dict = {"version": "2"}
    for name, value in _SCALAR_RE.findall(text_no_comments):
        mpc[name] = float(value)
    for name, body in _MATRIX_RE.findall(text_no_comments):
        rows = [r.split() for r in re.split(r"[;\n]", body) if r.strip()]
        width = max(len(r) for r in rows)
        # gencost rows may have different coefficient counts; pad with zeros
        mpc[name] = np.array([[float(v) for v in r] + [0.0] * (width - len(r)) for r in rows])
    for name, body in _CELL_RE.findall(text):
        mpc[name] = re.findall(r"'([^']*)'", body)

    for required in ("baseMVA", "bus", "gen", "branch"):
        if required not in mpc:
            raise ValueError(f"MATPOWER case is missing mpc.{required}")
    return mpc


def _strip_comment(line: str) -> str:
    # '%' starts a comment unless inside a quoted string
    in_quote = False
    for i, ch in enumerate(line):
        if ch == "'":
            in_quote = not in_quote
        elif ch == "%" and not in_quote:
            return line[:i]
    return line


def network_from_mpc(mpc: dict, name: str = "network") -> Network:
    names = mpc.get("bus_name")
    buses = [
        Bus(
            bus_id=int(row[BUS_I]),
            load_mw=float(row[PD]),
            name=names[i] if names else None,
            bus_type=int(row[BUS_TYPE]),
            shunt_mw=float(row[GS]),
            area=int(row[BUS_AREA]),
            base_kv=float(row[BASE_KV]),
        )
        for i, row in enumerate(mpc["bus"])
    ]

    gencost = mpc.get("gencost")
    generators = []
    for n, row in enumerate(mpc["gen"]):
        c2 = c1 = c0 = 0.0
        if gencost is not None:
            c2, c1, c0 = _polynomial_coefficients(gencost[n], n)
        generators.append(
            Generator(
                generator_id=f"G{n + 1}",
                bus_id=int(row[GEN_BUS]),
                p_min_mw=float(row[PMIN]),
                p_max_mw=float(row[PMAX]),
                offer_price=c1,
                cost_c2=c2,
                cost_c0=c0,
                p_mw=float(row[PG]),
                in_service=row[GEN_STATUS] > 0,
            )
        )

    branches = [
        Branch(
            branch_id=f"L{n + 1}",
            from_bus=int(row[F_BUS]),
            to_bus=int(row[T_BUS]),
            resistance_pu=float(row[BR_R]),
            reactance_pu=float(row[BR_X]),
            limit_mw=float(row[RATE_A]) if row[RATE_A] > 0 else math.inf,
            tap_ratio=float(row[TAP]) if row[TAP] != 0 else 1.0,
            phase_shift_deg=float(row[SHIFT]),
            in_service=row[BR_STATUS] > 0,
        )
        for n, row in enumerate(mpc["branch"])
    ]

    return Network(
        buses=buses,
        generators=generators,
        branches=branches,
        base_mva=float(mpc["baseMVA"]),
        name=name,
    )


def _polynomial_coefficients(row, n):
    if int(row[MODEL]) != POLYNOMIAL:
        raise NotImplementedError(f"Generator {n + 1}: piecewise-linear costs are not supported yet.")
    ncost = int(row[NCOST])
    if ncost > 3:
        raise NotImplementedError(f"Generator {n + 1}: cost polynomials above quadratic are not supported.")
    coeffs = list(row[COST:COST + ncost])  # highest order first
    coeffs = [0.0] * (3 - ncost) + coeffs
    return tuple(float(c) for c in coeffs)


def load_matpower(path: str | Path) -> Network:
    path = Path(path)
    mpc = parse_matpower(path.read_text())
    return network_from_mpc(mpc, name=path.stem)


CASES_DIR = Path(__file__).resolve().parent.parent / "cases"


def load_case(name: str) -> Network:
    """Load a bundled case by short name, e.g. 'case118' or 'pglib_opf_case118_ieee'."""
    candidates = [CASES_DIR / f"{name}.m", CASES_DIR / f"pglib_opf_{name}_ieee.m"]
    for path in candidates:
        if path.exists():
            return load_matpower(path)
    available = sorted(p.stem for p in CASES_DIR.glob("*.m"))
    raise FileNotFoundError(f"No case named {name!r}. Available: {available}")
