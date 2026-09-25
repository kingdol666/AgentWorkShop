# -*- coding: utf-8 -*-
"""AML Hybrid Twin 参考训练器。

物理优先：先用 physics.py/physics_parameters.json 给出主干预测，网络只学习有界残差。
输入：AML bundle x [N,H,nAll]，y [N,F,nTgt]；物理主干输出可由 job workspace 注入。
输出：artifacts/model.pt、model.onnx、physics_parameters.json、hybrid_metrics.json。

生产提交前必须由平台门禁重新计算指标；本文件不授予任何 DCW 权限。
"""
import json
import os
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import amlkit


class BoundedResidual(nn.Module):
    def __init__(self, n_in: int, n_out: int, hidden: int = 64, residual_scale: float = 0.25):
        super().__init__()
        self.residual_scale = float(residual_scale)
        self.net = nn.Sequential(
            nn.Flatten(),
            nn.Linear(n_in, hidden),
            nn.Tanh(),
            nn.Linear(hidden, n_out),
            nn.Tanh(),
        )

    def forward(self, x):
        return self.residual_scale * self.net(x)


def main():
    job_dir = Path(os.environ["AML_JOB_DIR"]).resolve()
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    bundle = amlkit.load_bundle(job["datasetPath"])
    manifest = bundle.manifest
    params = job.get("params", {})
    x = torch.tensor(bundle.get("x", "train"), dtype=torch.float32)
    y = torch.tensor(bundle.get("y", "train")[:, 0, :], dtype=torch.float32)
    if x.shape[0] == 0:
        raise RuntimeError("HYBRID_EMPTY_TRAIN")

    n_in = int(np.prod(x.shape[1:]))
    n_out = int(y.shape[-1])
    model = BoundedResidual(n_in, n_out, int(params.get("hidden", 64)), float(params.get("residual_scale", 0.25)))
    optimizer = torch.optim.Adam(model.parameters(), lr=float(params.get("lr", 1e-3)))
    epochs = int(params.get("epochs", 80))
    loss_fn = nn.MSELoss()
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        residual = model(x)
        # 物理优先：此处默认 physics_next=0，真实场景由 provider 输出后写入 bundle/physics target。
        loss_data = loss_fn(residual, y)
        loss_bound = torch.mean(torch.relu(torch.abs(residual) - float(params.get("residual_scale", 0.25))) ** 2)
        loss = loss_data + 0.1 * loss_bound
        loss.backward()
        optimizer.step()
        if epoch % max(1, epochs // 20) == 0 or epoch == epochs - 1:
            amlkit.report_progress(5 + int(85 * (epoch + 1) / epochs), f"hybrid epoch={epoch + 1}/{epochs} loss={float(loss):.6f}")

    model.eval()
    artifact_dir = Path(amlkit._artifacts_dir())
    torch.save({"state_dict": model.state_dict(), "residual_scale": model.residual_scale}, artifact_dir / "model.pt")
    amlkit.export_torch_onnx(model, manifest)
    physics_params = job.get("physicsParameters", {})
    (artifact_dir / "physics_parameters.json").write_text(json.dumps(physics_params, ensure_ascii=False, indent=2), encoding="utf-8")
    metrics = {
        "kind": "hybrid_physics_residual",
        "backend": "pytorch",
        "residualBound": model.residual_scale,
        "epochs": epochs,
        "trainRows": int(x.shape[0]),
        "physicsFirst": True,
    }
    amlkit.save_metrics({"hybrid": metrics})
    (artifact_dir / "hybrid_metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    amlkit.report_progress(99, "hybrid artifacts exported")


if __name__ == "__main__":
    main()
