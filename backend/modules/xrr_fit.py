"""
XRR Fit Module
==============
Reflectivity fitting using refnx Parratt formalism. Reads its data from the
XRR plotting module (upstream), so no separate file upload is needed.

The actual fitting code lives in the schema's analysis_code; this class
just registers the module in the registry.
"""

from .base import LabModule


class XRRFitModule(LabModule):
    id          = "xrr_fit"
    name        = "XRR Fit"
    description = "Parratt reflectivity fit (uses XRR module's data)"
    accepts     = []                           # derived module — no file upload
    version     = "0.1"
    author      = "built-in"

    def parse(self, file_bytes: bytes, filename: str, meta: dict) -> dict:
        return None

    def plot(self, data: dict, meta: dict, options: dict) -> dict:
        return {}
