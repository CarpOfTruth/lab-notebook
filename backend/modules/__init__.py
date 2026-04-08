"""
Module registry — discovers and loads all LabLog measurement modules.

Built-in modules live alongside this file.
User modules live in  data/user_modules/  (one .py file per module).

A module file must define a class that subclasses LabModule and is named
with the suffix "Module" (e.g. PEModule, RamanModule).  The first such
class found in the file is registered.
"""

import importlib.util
import inspect
import sys
from pathlib import Path
from typing import Optional
from .base import LabModule

# Directories
_BUILTIN_DIR  = Path(__file__).parent
_USER_DIR     = Path(__file__).parent.parent / "data" / "user_modules"
_USER_DIR.mkdir(parents=True, exist_ok=True)

# Built-in module filenames (order = display order in the UI)
_BUILTIN_MODULES = ["pe"]

_registry: dict[str, LabModule] = {}


def _load_module_file(path: Path, builtin: bool = False) -> Optional[LabModule]:
    """Import a .py file and return an instantiated LabModule subclass, or None."""
    try:
        mod_name = f"labmodule_{path.stem}"
        spec = importlib.util.spec_from_file_location(mod_name, path)
        mod  = importlib.util.module_from_spec(spec)
        # Make base available as a sibling so relative imports resolve
        mod.__package__ = "modules"
        sys.modules.setdefault("modules", sys.modules.get(__name__))
        sys.modules.setdefault("modules.base", sys.modules.get(f"{__name__.rsplit('.', 1)[0]}.base" if "." in __name__ else "modules.base"))
        spec.loader.exec_module(mod)
        for _, cls in inspect.getmembers(mod, inspect.isclass):
            if (
                issubclass(cls, LabModule)
                and cls is not LabModule
                and cls.__module__ == mod_name
            ):
                instance = cls()
                return instance
    except Exception as e:
        print(f"[modules] Failed to load {path}: {e}")
    return None


def _reload():
    global _registry
    _registry = {}

    # Built-ins
    for name in _BUILTIN_MODULES:
        path = _BUILTIN_DIR / f"{name}.py"
        inst = _load_module_file(path, builtin=True)
        if inst:
            _registry[inst.id] = inst

    # User modules (override built-ins if same id)
    for path in sorted(_USER_DIR.glob("*.py")):
        inst = _load_module_file(path, builtin=False)
        if inst:
            _registry[inst.id] = inst


def get(module_id: str) -> Optional[LabModule]:
    if not _registry:
        _reload()
    return _registry.get(module_id)


def all_modules() -> list[LabModule]:
    if not _registry:
        _reload()
    return list(_registry.values())


def source(module_id: str) -> Optional[str]:
    """Return the raw source of a module file."""
    if not _registry:
        _reload()
    # Check user dir first
    user_path = _USER_DIR / f"{module_id}.py"
    if user_path.exists():
        return user_path.read_text()
    builtin_path = _BUILTIN_DIR / f"{module_id}.py"
    if builtin_path.exists():
        return builtin_path.read_text()
    return None


def save_user_module(module_id: str, code: str) -> LabModule:
    """Write a user module file, reload the registry, return the instance."""
    path = _USER_DIR / f"{module_id}.py"
    path.write_text(code)
    _reload()
    inst = _registry.get(module_id)
    if not inst:
        raise ValueError(f"Module '{module_id}' did not load correctly — check for syntax errors")
    return inst


def delete_user_module(module_id: str):
    """Remove a user module file and reload."""
    # Never allow deleting built-ins
    builtin_path = _BUILTIN_DIR / f"{module_id}.py"
    if builtin_path.exists():
        raise ValueError(f"'{module_id}' is a built-in module and cannot be deleted")
    user_path = _USER_DIR / f"{module_id}.py"
    if not user_path.exists():
        raise FileNotFoundError(f"User module '{module_id}' not found")
    user_path.unlink()
    _reload()


# Eager load on import
_reload()
