#!/bin/bash
set -euo pipefail
cat > /app/stats.py <<'PY'
def average(values):
    values = list(values)
    if not values:
        raise ValueError("Cannot average an empty iterable")
    return sum(values) / len(values)
PY
