"""TopInspect 推理封装：DataFrame → 每条流的异常分数与判定。复用 models/ 与现有归一化逻辑。"""
import os
import pickle
import time

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader
from torch_geometric.data import Data

from models.topinspect import TopInspect
from utils.dataloaders import SequentialDataset, collate_fn
from utils.trainers import calculate_errors
from server import config

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


class ColumnMismatchError(Exception):
    def __init__(self, missing):
        self.missing = missing
        super().__init__(f"CSV 缺少必要列: {missing}")


def validate_columns(df):
    """校验 DataFrame 是否含 NetFlow v3 所需的全部列（标签列可选）。"""
    required = config.NON_FEATURE_COLS_V3 + config.EDGE_FEATURES_V3
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ColumnMismatchError(missing)


def _load_scaler(dataset):
    path = os.path.join(config.DATA_DIR, "pyg_graph_data", dataset, "scaler.pkl")
    with open(path, "rb") as f:
        return pickle.load(f)


def _build_graph(df, scaler):
    """DataFrame → PyG Data。节点=唯一IP，边=流。返回 (data, node_list, src_idx, dst_idx)。"""
    x_feat = df[config.EDGE_FEATURES_V3].replace([np.inf, -np.inf], np.nan).fillna(0)
    scaled = np.clip(scaler.transform(x_feat), -10, 10)

    src_ip = df["IPV4_SRC_ADDR"].astype(str).values
    dst_ip = df["IPV4_DST_ADDR"].astype(str).values
    unique_nodes = pd.unique(np.concatenate([src_ip, dst_ip]))
    node_map = {ip: i for i, ip in enumerate(unique_nodes)}
    num_nodes = len(node_map)

    src_idx = np.array([node_map[ip] for ip in src_ip])
    dst_idx = np.array([node_map[ip] for ip in dst_ip])
    edge_index = torch.tensor(np.array([src_idx, dst_idx]), dtype=torch.long)
    edge_attr = torch.tensor(scaled, dtype=torch.float)
    x = torch.ones(num_nodes, edge_attr.shape[1], dtype=torch.float)
    data = Data(x=x, edge_index=edge_index, edge_attr=edge_attr, num_nodes=num_nodes)
    return data, list(unique_nodes), src_idx, dst_idx


def load_model(checkpoint_path=None, hparams=None):
    """加载模型与阈值。返回 (model, threshold)。

    hparams 缺省用 config.MODEL_HPARAMS（主检测/baseline 架构）。
    """
    checkpoint_path = checkpoint_path or config.DEFAULT_CHECKPOINT
    hp = hparams or config.MODEL_HPARAMS
    edim_in = len(config.EDGE_FEATURES_V3)
    model = TopInspect(
        ndim_in=edim_in,
        edim_in=edim_in,
        edim_out=hp["edim_out"],
        embed_dim=hp["ae_embedding_dim"],
        num_heads=hp["num_heads"],
        num_layers=hp["num_layers"],
        window_size=hp["window_size"],
        dropout=hp["dropout"],
        ae_dropout=hp["ae_dropout"],
        positional_encoding=hp["positional_encoding"],
        agg_type=hp["agg_type"],
        mask_ratio=hp["mask_ratio"],
        encoder_type=hp.get("encoder_type", "baseline"),
    ).to(DEVICE)
    _, threshold = model.load_checkpoint(checkpoint_path)
    model.eval()
    return model, threshold


def score_graph(data, model, threshold, progress_cb=None):
    """对已建好的 PyG 图用指定模型打分。返回 dict：scores, preds, threshold, latency_ms。

    progress_cb(pct:int, rows_done:int) 可选，仅推理阶段（40→80）回调。
    """
    window = config.MODEL_HPARAMS["window_size"]
    t0 = time.perf_counter()
    with torch.inference_mode():
        edge_couples = data.edge_index.t()
        emb = model.encoder(data.edge_index, data.edge_attr, edge_couples, data.num_nodes)
        loader = DataLoader(
            SequentialDataset(emb, window=window, step=window, device=DEVICE),
            batch_size=config.AE_BATCH_SIZE,
            collate_fn=collate_fn,
        )
        errors = []
        total = max(1, len(loader))
        for i, (ae_batch, mask) in enumerate(loader):
            out = model.transformer(ae_batch, mask)
            errors.append(calculate_errors(out, ae_batch, mask).cpu())
            if progress_cb:
                done = int(sum(len(e) for e in errors))
                progress_cb(40 + int(40 * (i + 1) / total), done)
        scores = torch.cat(errors).numpy()
    latency_ms = (time.perf_counter() - t0) * 1000.0

    preds = (scores > threshold).astype(int)
    return {
        "scores": scores,
        "preds": preds,
        "threshold": float(threshold),
        "latency_ms": latency_ms,
    }


def build_graph(df, dataset=config.DEFAULT_DATASET):
    """DataFrame → (data, node_list, src_idx, dst_idx)，含归一化。供推理与对比复用。"""
    scaler = _load_scaler(dataset)
    return _build_graph(df, scaler)


def run_inference(df, model, threshold, dataset=config.DEFAULT_DATASET, progress_cb=None):
    """对 DataFrame 推理。返回 dict：scores, preds, node_list, src_idx, dst_idx, threshold,
    latency_ms, graph（建好的 PyG Data）。

    progress_cb(pct:int, rows_done:int) 可选，用于流式进度。
    每条流（边）对应一个分数，scores 长度 == len(df)。
    """
    if progress_cb:
        progress_cb(20, 0)
    data, node_list, src_idx, dst_idx = build_graph(df, dataset)
    data = data.to(DEVICE)
    if progress_cb:
        progress_cb(40, 0)

    scored = score_graph(data, model, threshold, progress_cb=progress_cb)
    scored.update({
        "node_list": node_list,
        "src_idx": src_idx,
        "dst_idx": dst_idx,
        "graph": data,
    })
    return scored
