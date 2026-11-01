"""Trade Lab skills. Every module in this folder (not starting with "_") that defines
SKILL and Skill is picked up automatically by skilltest.py. See README.md here."""
import importlib, pkgutil


def load_all():
    mods = []
    for m in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        if m.name.startswith("_"):
            continue
        mod = importlib.import_module(f"{__name__}.{m.name}")
        if hasattr(mod, "SKILL") and hasattr(mod, "Skill"):
            mods.append(mod)
    return mods
