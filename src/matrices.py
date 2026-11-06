"""DC network matrices: susceptances, islands, PTDF and LODF.

Conventions follow MATPOWER's makeBdc:
    branch flow (pu)    Pf = Bf @ theta + Pfinj
    bus injection (pu)  P  = Bbus @ theta + Pbusinj
where Pfinj / Pbusinj come from phase-shifting transformers.
"""

from __future__ import annotations

from functools import cached_property

import numpy as np
import scipy.sparse as sp
from scipy.sparse.csgraph import connected_components
from scipy.sparse.linalg import splu

from src.models import ISOLATED, Network

# A branch whose own transfer factor is this close to 1 is a bridge: removing it splits an island.
BRIDGE_TOL = 1e-6


class DcModel:
    """Linear DC model of a Network snapshot. Rebuild it after editing the network."""

    def __init__(self, network: Network):
        self.network = network
        self.base_mva = network.base_mva
        self.bus_ids = [b.bus_id for b in network.buses]
        self.branch_ids = [br.branch_id for br in network.branches]
        self.nb = len(network.buses)
        self.nl = len(network.branches)

        idx = network.bus_index
        self.f_idx = np.array([idx[br.from_bus] for br in network.branches], dtype=int)
        self.t_idx = np.array([idx[br.to_bus] for br in network.branches], dtype=int)
        self.in_service = np.array([br.in_service for br in network.branches], dtype=bool)

        x = np.array([br.reactance_pu for br in network.branches], dtype=float)
        tap = np.array([br.tap_ratio for br in network.branches], dtype=float)
        shift = np.deg2rad([br.phase_shift_deg for br in network.branches])
        with np.errstate(divide="ignore"):
            self.b = np.where(self.in_service, 1.0 / (x * tap), 0.0)

        rows = np.arange(self.nl)
        cft = sp.csr_matrix(
            (np.r_[np.ones(self.nl), -np.ones(self.nl)], (np.r_[rows, rows], np.r_[self.f_idx, self.t_idx])),
            shape=(self.nl, self.nb),
        )
        self.Cft = cft
        self.Bf = sp.diags(self.b) @ cft
        self.Bbus = (cft.T @ self.Bf).tocsc()
        self.Pfinj = -self.b * shift
        self.Pbusinj = cft.T @ self.Pfinj

        self.limit_mw = np.array(
            [br.limit_mw if br.is_limited else np.inf for br in network.branches], dtype=float
        )

        self._find_islands()

    # ------------------------------------------------------------------ islands
    def _find_islands(self):
        net = self.network
        on = self.in_service
        adj = sp.csr_matrix(
            (np.ones(on.sum()), (self.f_idx[on], self.t_idx[on])), shape=(self.nb, self.nb)
        )
        _, labels = connected_components(adj, directed=False)
        # isolated-type buses are their own islands even if a line is still attached
        for i, bus in enumerate(net.buses):
            if bus.bus_type == ISOLATED:
                labels[i] = labels.max() + 1

        islands = [np.flatnonzero(labels == lab) for lab in np.unique(labels)]
        islands.sort(key=lambda isl: (-len(isl), isl[0]))
        self.islands: list[np.ndarray] = islands
        self.island_of = np.empty(self.nb, dtype=int)
        for k, isl in enumerate(islands):
            self.island_of[isl] = k
        self.island_refs = np.array([self._pick_ref(isl) for isl in islands], dtype=int)

    def _pick_ref(self, island: np.ndarray) -> int:
        net = self.network
        ref = net.bus_index[net.reference_bus_id]
        if ref in island:
            return ref
        members = set(island.tolist())
        for i in island:
            if net.buses[i].bus_type == 3:
                return int(i)
        capacity = {}
        for g in net.generators:
            i = net.bus_index[g.bus_id]
            if g.in_service and i in members:
                capacity[i] = capacity.get(i, 0.0) + g.p_max_mw
        if capacity:
            return max(capacity, key=capacity.get)
        return int(island[0])

    @property
    def n_islands(self) -> int:
        return len(self.islands)

    # ------------------------------------------------------------------ solves
    @cached_property
    def _non_ref(self) -> np.ndarray:
        mask = np.ones(self.nb, dtype=bool)
        mask[self.island_refs] = False
        return np.flatnonzero(mask)

    @cached_property
    def _lu(self):
        nr = self._non_ref
        if len(nr) == 0:
            return None
        return splu(self.Bbus[nr][:, nr].tocsc())

    def solve_angles(self, injections_mw: np.ndarray) -> np.ndarray:
        """Bus voltage angles (rad) for net bus injections in MW. Reference buses are at 0.

        Each island's injections must balance; the reference bus row is not enforced.
        """
        p = np.asarray(injections_mw, dtype=float) / self.base_mva - self.Pbusinj
        theta = np.zeros(self.nb)
        nr = self._non_ref
        if len(nr):
            theta[nr] = self._lu.solve(p[nr])
        return theta

    def branch_flows_mw(self, theta: np.ndarray) -> np.ndarray:
        return (self.Bf @ theta + self.Pfinj) * self.base_mva

    def bus_injections_mw(self, theta: np.ndarray) -> np.ndarray:
        return (self.Bbus @ theta + self.Pbusinj) * self.base_mva

    # ------------------------------------------------------------------ sensitivities
    @cached_property
    def ptdf(self) -> np.ndarray:
        """Branch-by-bus PTDF (nl x nb): MW flow change on each branch per MW injected at a bus
        and withdrawn at that bus's island reference. Rows of out-of-service branches are zero."""
        H = np.zeros((self.nl, self.nb))
        nr = self._non_ref
        if len(nr):
            # H[:, nr] = Bf[:, nr] @ inv(Bbus[nr, nr]); Bbus is symmetric so solve the transpose
            X = self._lu.solve(self.Bf[:, nr].T.toarray())
            H[:, nr] = X.T
        return H

    def transfer_ptdf(self, source_bus_id: int, sink_bus_id: int) -> np.ndarray:
        """Flow change on each branch for 1 MW injected at source and withdrawn at sink."""
        s = self.network.bus_index[source_bus_id]
        t = self.network.bus_index[sink_bus_id]
        if self.island_of[s] != self.island_of[t]:
            raise ValueError(f"Buses {source_bus_id} and {sink_bus_id} are in different islands.")
        return self.ptdf[:, s] - self.ptdf[:, t]

    @cached_property
    def lodf(self) -> np.ndarray:
        """Line outage distribution factors (nl x nl).

        lodf[l, k] is the fraction of branch k's pre-outage flow that moves onto branch l when k
        is removed. Column k is NaN if k is out of service or its outage would split an island.
        """
        H = self.ptdf
        transfer = H[:, self.f_idx] - H[:, self.t_idx]  # column k: PTDF for a transfer across k
        denom = 1.0 - np.diag(transfer)
        valid = self.in_service & (np.abs(denom) > BRIDGE_TOL)
        L = np.full((self.nl, self.nl), np.nan)
        L[:, valid] = transfer[:, valid] / denom[valid]
        L[np.flatnonzero(valid), np.flatnonzero(valid)] = -1.0
        return L

    @cached_property
    def bridges(self) -> list[str]:
        """In-service branches whose outage would split an island (radial lines)."""
        H = self.ptdf
        diag = H[np.arange(self.nl), self.f_idx] - H[np.arange(self.nl), self.t_idx]
        mask = self.in_service & (np.abs(1.0 - diag) <= BRIDGE_TOL)
        return [self.branch_ids[k] for k in np.flatnonzero(mask)]

    def outage_flows_mw(self, base_flows_mw: np.ndarray, outaged_branch_id: str) -> np.ndarray:
        """Post-outage flows from pre-outage flows using LODF (no re-solve)."""
        k = self.branch_ids.index(outaged_branch_id)
        col = self.lodf[:, k]
        if np.isnan(col).any():
            raise ValueError(f"Outage of {outaged_branch_id} splits an island or it is already out.")
        return base_flows_mw + col * base_flows_mw[k]
