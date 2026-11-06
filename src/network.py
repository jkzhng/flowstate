from src.matrices import DcModel
from src.models import Network


def build_susceptance_matrix(buses, branches):
    """Dense bus susceptance matrix (pu). Accounts for taps and out-of-service branches."""
    network = Network(buses=buses, generators=[], branches=branches)
    return DcModel(network).Bbus.toarray()
