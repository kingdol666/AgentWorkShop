# -*- coding: utf-8 -*-
"""0.7.46 验收用加强训练实现(内联 code 路径,仍走 amlkit 契约)。

与平台参考实现 `train-example.py` 的差异:
  1. 平台 bundle 的归一化对 σ<1 的列按 std=1 兜底(见 dataset-builder.meanStd),
     于是熔温/克重这类物理量保持原始量纲,MLP 条件数极差 → 本实现按**训练集自身**
     重新 z-score(输入、输出各一套),并在导出前把输出层折回契约量纲;
  2. 两层 MLP + ReLU(参考实现是单隐层),Adam + 余弦退火;
  3. 保存 val 最优权重并在结束时回滚(best-val checkpoint),抑制后期过拟合。

契约不变:输入 [N,H,nAll](契约归一化空间)→ 输出 [N,nTgt](契约归一化空间的下一拍目标)。
超参:lr / epochs / hidden / batch。
"""
import json
import math
import os
from pathlib import Path

import torch
import torch.nn as nn

import amlkit


class ZScoreNet(nn.Module):
    """内部 z-score 标准化 + 两层 MLP;forward 输出折回契约量纲(mean/std 由训练集统计)。"""

    def __init__(self, n_in, hidden, n_out, x_mean, x_std, y_mean, y_std):
        super().__init__()
        self.register_buffer("x_mean", torch.tensor(x_mean, dtype=torch.float32))
        self.register_buffer("x_std", torch.tensor(x_std, dtype=torch.float32))
        self.register_buffer("y_mean", torch.tensor(y_mean, dtype=torch.float32))
        self.register_buffer("y_std", torch.tensor(y_std, dtype=torch.float32))
        self.net = nn.Sequential(
            nn.Flatten(),
            nn.Linear(n_in, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, n_out),
        )

    def forward(self, x):
        z = (x - self.x_mean) / self.x_std
        out = self.net(z)
        return out * self.y_std + self.y_mean


def main():
    job_dir = Path(os.environ["AML_JOB_DIR"]).resolve()
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    params = job.get("params", {})

    bundle = amlkit.load_bundle(job["datasetPath"])
    manifest = bundle.manifest
    h_steps = manifest["shapes"]["x"][1]
    n_all = manifest["shapes"]["x"][2]
    n_tgt = manifest["shapes"]["y"][2]

    x_train = bundle.get("x", "train")
    y_train = bundle.get("y", "train")[:, 0, :]
    x_val = bundle.get("x", "val")
    y_val = bundle.get("y", "val")[:, 0, :]
    x_test = bundle.get("x", "test")
    y_test = bundle.get("y", "test")[:, 0, :]

    xt = torch.tensor(x_train, dtype=torch.float32)
    yt = torch.tensor(y_train, dtype=torch.float32)
    xv = torch.tensor(x_val, dtype=torch.float32) if x_val.shape[0] else None
    yv = torch.tensor(y_val, dtype=torch.float32) if y_val.shape[0] else None

    # 训练集统计量(不用 val/test,避免信息泄漏)
    x_mean = xt.mean(dim=(0, 1), keepdim=False).reshape(-1).tolist()
    x_std = torch.clamp(xt.reshape(-1, n_all).std(dim=0), min=1e-6).tolist()
    y_mean = yt.mean(dim=0).tolist()
    y_std = torch.clamp(yt.std(dim=0), min=1e-6).tolist()

    hidden = int(params.get("hidden", 128))
    model = ZScoreNet(h_steps * n_all, hidden, n_tgt, x_mean, x_std, y_mean, y_std)
    opt = torch.optim.Adam(model.parameters(), lr=float(params.get("lr", 3e-3)))
    epochs = int(params.get("epochs", 400))
    batch = int(params.get("batch", 64))
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs))
    loss_fn = nn.MSELoss()

    n = xt.shape[0]
    best_val = float("inf")
    best_state = None
    train_loss = 0.0
    val_loss = None
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(n)
        total = 0.0
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            opt.zero_grad()
            loss = loss_fn(model(xt[idx]), yt[idx])
            loss.backward()
            opt.step()
            total += float(loss) * idx.shape[0]
        sched.step()
        train_loss = total / max(1, n)
        if xv is not None:
            model.eval()
            with torch.no_grad():
                val_loss = float(loss_fn(model(xv), yv))
            if val_loss < best_val:
                best_val = val_loss
                best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        amlkit.report_progress(
            5 + 90 * (epoch + 1) // epochs,
            "epoch %d/%d train=%.6f val=%s" % (epoch + 1, epochs, train_loss, val_loss if val_loss is not None else "n/a"),
        )

    if best_state is not None:
        model.load_state_dict(best_state)

    test_rmse = None
    if x_test.shape[0]:
        model.eval()
        with torch.no_grad():
            pred = model(torch.tensor(x_test, dtype=torch.float32))
            test_rmse = float(torch.sqrt(torch.mean((pred - torch.tensor(y_test, dtype=torch.float32)) ** 2)))

    amlkit.save_metrics({"agent": {
        "kind": "zscore_mlp_two_layer_bestval",
        "epochs": epochs,
        "train_loss_last": train_loss,
        "val_loss_best": None if best_val == float("inf") else best_val,
        "test_rmse_normalized": test_rmse,
        "x_std_min": min(x_std),
        "params": params,
    }})

    amlkit.export_torch_onnx(model, manifest)
    amlkit.report_progress(99, "exported onnx (zscore 2-layer)")
    print("train-strong done rmse=%s" % (test_rmse if test_rmse is not None else "n/a"))


if __name__ == "__main__":
    main()
