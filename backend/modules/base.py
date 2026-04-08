"""
LabLog Module Interface
=======================

Every measurement-type module must subclass LabModule and implement:

    parse(file_bytes, filename, meta)  →  dict
    plot(data, meta, options)          →  dict  (Plotly figure JSON)

The optional analyze() method adds fitting / analysis capability.

meta keys passed in from the sample record:
    thickness_nm : float | None   — active layer thickness
    area_m2      : float | None   — electrode area
    technique    : str            — "sputter" etc.
"""

from abc import ABC, abstractmethod


class LabModule(ABC):
    # ── Required class-level metadata ─────────────────────────────────────────
    id: str           # unique snake_case identifier, e.g. "pe"
    name: str         # human-readable, e.g. "P-E Loop"
    description: str  # one-line description shown in the module browser
    accepts: list     # file extensions, e.g. [".csv", ".dat", ".txt"]
    version: str      # semver string
    author: str       # "built-in" or a name

    # ── Required methods ───────────────────────────────────────────────────────

    @abstractmethod
    def parse(self, file_bytes: bytes, filename: str, meta: dict) -> dict:
        """
        Convert raw file bytes into a structured data dict.

        The returned dict is what gets cached and passed to plot() / analyze().
        It must be JSON-serialisable.  Return None to signal a parse failure.
        """

    @abstractmethod
    def plot(self, data: dict, meta: dict, options: dict) -> dict:
        """
        Convert structured data into a Plotly figure dict.

        Return value must match the shape that plotly.graph_objects.Figure
        produces via .to_dict() — i.e. {"data": [...], "layout": {...}}.
        The frontend renders this directly with <Plot {...spec} />.
        """

    # ── Optional methods ───────────────────────────────────────────────────────

    def analyze(self, data: dict, params: dict) -> dict:
        """
        Optional.  Run fitting / analysis and return:
            {
              "results": { ... },          # scalar values shown in the UI
              "overlay": { ... },          # Plotly figure dict merged onto plot
            }
        """
        raise NotImplementedError

    @property
    def has_analysis(self) -> bool:
        try:
            self.analyze({}, {})
        except NotImplementedError:
            return False
        except Exception:
            return True
        return True

    def to_info(self) -> dict:
        """Serialisable summary for the module browser."""
        return {
            "id":          self.id,
            "name":        self.name,
            "description": self.description,
            "accepts":     self.accepts,
            "version":     self.version,
            "author":      self.author,
            "builtin":     self.author == "built-in",
            "has_analysis": False,  # overridden after instantiation
        }
