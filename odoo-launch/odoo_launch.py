"""Run odoo-bin, optionally dropping the target database first.

Used as the "program" of the VSCode launch configs: VSCode cannot share an
input (the DB name) between a launch config and its preLaunchTask, so the drop
happens here, in the debugged process, before handing over to odoo-bin.

    ODOO_DROP_DB=yes python odoo_launch.py <odoo-bin args with -d/--database>
"""
import os
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

ODOO_BIN = Path.home() / "odoo" / "odoo-bin"


def database_name(argv):
    for i, arg in enumerate(argv):
        if arg in ("-d", "--database") and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--database="):
            return arg.split("=", 1)[1]
    return None


if os.environ.get("ODOO_DROP_DB") == "yes":
    db = database_name(sys.argv[1:])
    if not db:
        sys.exit("ODOO_DROP_DB=yes but no -d/--database given")
    print(f"Dropping database {db!r} and its filestore")
    subprocess.run(["dropdb", "--if-exists", db], check=True)
    shutil.rmtree(Path.home() / ".local/share/Odoo/filestore" / db, ignore_errors=True)

# Behave as if odoo-bin had been launched directly (its dir first on sys.path).
sys.argv[0] = str(ODOO_BIN)
sys.path[0] = str(ODOO_BIN.parent)
runpy.run_path(str(ODOO_BIN), run_name="__main__")
