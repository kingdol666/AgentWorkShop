# -*- coding: utf-8 -*-
"""Pure PyTorch smoke acceptance for physical-first + bounded residual training.
No PLC/DCW access. It intentionally omits ONNX export when onnx packages are unavailable.
"""
import json
from pathlib import Path
from datetime import datetime, timezone
import torch
import torch.nn as nn

torch.manual_seed(42)
N = 512
pressure = torch.linspace(55.0, 75.0, N).unsqueeze(1)
true = 31.8 + 0.10 * (pressure - 60.0) + 0.04 * torch.sin(pressure / 2.0)
physics = 31.8 + 0.10 * (pressure - 60.0)
residual_target = true - physics
model = nn.Sequential(nn.Linear(1, 16), nn.Tanh(), nn.Linear(16, 1), nn.Tanh())
scale = 0.15
opt = torch.optim.Adam(model.parameters(), lr=0.02)
losses = []
for _ in range(120):
    opt.zero_grad()
    residual = scale * model(pressure)
    loss = ((residual - residual_target) ** 2).mean()
    loss.backward()
    opt.step()
    losses.append(float(loss.detach()))
with torch.no_grad():
    pred_res = scale * model(pressure)
    pred = physics + pred_res
report = {
    'generatedAt': datetime.now(timezone.utc).isoformat(),
    'backend': 'pytorch',
    'physicsFirst': True,
    'rows': N,
    'lossInitial': losses[0],
    'lossFinal': losses[-1],
    'lossDecreased': losses[-1] < losses[0],
    'residualBound': scale,
    'maxAbsResidual': float(pred_res.abs().max()),
    'residualBoundRespected': bool(float(pred_res.abs().max()) <= scale + 1e-6),
    'rmse': float(torch.sqrt(((pred - true) ** 2).mean())),
    'recommendationOnly': True,
    'dcwWrites': 0,
}
out = Path('bench/results/aml-hybrid-python-smoke.json')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
if not (report['lossDecreased'] and report['residualBoundRespected']):
    raise SystemExit(1)
