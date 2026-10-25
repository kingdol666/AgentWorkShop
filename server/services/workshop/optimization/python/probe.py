"""能力探针:解释器/依赖可用性(不抛异常;退出码 0 = 全部可用)。"""
import json
import sys

result = {"python": sys.version.split()[0], "osqp": None, "scipy": None, "numpy": None}
try:
    import numpy  # type: ignore
    result["numpy"] = numpy.__version__
except Exception:
    pass
try:
    import scipy  # type: ignore
    result["scipy"] = scipy.__version__
except Exception:
    pass
try:
    import osqp  # type: ignore
    result["osqp"] = osqp.__version__
except Exception:
    pass

sys.stdout.write(json.dumps(result) + "\n")
ok = result["scipy"] is not None and result["osqp"] is not None and result["numpy"] is not None
sys.exit(0 if ok else 3)
