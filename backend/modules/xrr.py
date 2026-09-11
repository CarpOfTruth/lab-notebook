"""
XRR Module
==========
X-ray reflectivity — parses raw two-column (2θ, intensity) data from
reflectometry scans and returns a log-intensity plot.

Parsing notes
-------------
- Skips any line whose first token is not numeric (comments, headers).
- Detects omega-scan files (instrument exports ω instead of 2θ) by looking
  for "omega" without "2theta" / "2T" in the first 12 header lines, then
  doubles x.
- Handles tab, space, and comma delimiters.

The actual runtime processing is in the schema proc_code (executed by
render-for-sample).  This class registers the module in the registry and
provides metadata; parse()/plot() are stubs.
"""

from .base import LabModule


class XRRModule(LabModule):
    id          = "xrr"
    name        = "XRR"
    description = "X-ray reflectivity — raw 2θ vs. intensity"
    accepts     = [".xy", ".xye", ".dat", ".txt", ".csv", ".asc"]
    version     = "1.0"
    author      = "built-in"

    # Runtime processing is handled by proc_code in the schema JSON.
    # These stubs satisfy the abstract interface.

    def parse(self, file_bytes: bytes, filename: str, meta: dict) -> dict:
        return None

    def plot(self, data: dict, meta: dict, options: dict) -> dict:
        return {}
