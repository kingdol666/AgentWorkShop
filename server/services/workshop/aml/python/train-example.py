# -*- coding: utf-8 -*-
"""AML 参考训练实现(one-step 线性基线;e2e --real 模式与 Agent 的起点范本)。

契约:
  - 数据:amlkit.load_bundle(归一化 float32;x [N,H,nAll] / y [N,F,nTgt]);
  - 模型:输入 [batch, H, nAll](展平)→ 输出 [batch, nTgt](下一拍目标,归一化);
  - 产出:amlkit.export_torch_onnx(契约 ONNX)+ amlkit.save_metrics(自报指标,门禁另由平台评估器复算)。

超参经作业 params 传入:lr / epochs / hidden / batch。
"""
import json
import os
from pathlib import Path

import torch
import torch.nn as nn

import amlkit


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
    y_train = bundle.get("y", "train")[:, 0, :]  # 下一拍目标(第 0 个 horizon 步)
    x_val = bundle.get("x", "val")
    y_val = bundle.get("y", "val")[:, 0, :]

    hidden = int(params.get("hidden", 128))
    model = nn.Sequential(
        nn.Flatten(),
        nn.Linear(h_steps * n_all, hidden),
        nn.ReLU(),
        nn.Linear(hidden, n_tgt),
    )
    opt = torch.optim.Adam(model.parameters(), lr=float(params.get("lr", 1e-3)))
    loss_fn = nn.MSELoss()

    xt = torch.tensor(x_train, dtype=torch.float32)
    yt = torch.tensor(y_train, dtype=torch.float32)
    xv = torch.tensor(x_val, dtype=torch.float32) if x_val.shape[0] else None
    yv = torch.tensor(y_val, dtype=torch.float32) if y_val.shape[0] else None

    epochs = int(params.get("epochs", 80))
    batch = int(params.get("batch", 256))
    n = xt.shape[0]
    best_val = float("inf")
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
        train_loss = total / max(1, n)
        if xv is not None:
            model.eval()
            with torch.no_grad():
                val_loss = float(loss_fn(model(xv), yv))
            best_val = min(best_val, val_loss)
        amlkit.report_progress(5 + 90 * (epoch + 1) // epochs,
                               "epoch %d/%d train=%.5f val=%s" % (epoch + 1, epochs, train_loss, val_loss if val_loss is not None else "n/a"))

    amlkit.save_metrics({"agent": {
        "kind": "mlp_one_step_baseline",
        "epochs": epochs,
        "train_loss_last": train_loss,
        "val_loss_best": None if val_loss is None else best_val,
        "params": params,
    }})

    amlkit.export_torch_onnx(model, manifest)
    amlkit.report_progress(99, "exported onnx")
    print("train-example done")


if __name__ == "__main__":
    main()
