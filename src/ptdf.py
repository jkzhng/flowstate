from src.matrices import DcModel
from src.models import Network


def calculate_ptdf(buses, branches, base_mva, source_bus_id, sink_bus_id, reference_bus_id):
    """Flow change on each branch for a 1 MW source->sink transfer, keyed by branch_id.

    Keyed by branch_id rather than (from_bus, to_bus) so parallel circuits stay distinct.
    For many transfers, build a DcModel once and use DcModel.ptdf / transfer_ptdf directly.
    """
    if source_bus_id == sink_bus_id:
        raise ValueError("Source and sink buses must differ.")
    network = Network(buses=buses, generators=[], branches=branches,
                      base_mva=base_mva, reference_bus_id=reference_bus_id)
    if source_bus_id not in network.bus_index or sink_bus_id not in network.bus_index:
        raise ValueError("Source or sink bus does not exist.")
    model = DcModel(network)
    return dict(zip(model.branch_ids, model.transfer_ptdf(source_bus_id, sink_bus_id).tolist()))
