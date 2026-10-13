"""FastAPI 应用：路由 + CORS + SSE + 静态托管前端。"""
import asyncio
import io
import json
import os
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

from server import config, inference
from server.jobs import JobManager

app = FastAPI(title="TopInspect API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_mgr = JobManager()
_model = None
_threshold = None


def _ensure_model():
    global _model, _threshold
    if _model is None:
        if not os.path.exists(config.DEFAULT_CHECKPOINT):
            raise HTTPException(500, f"checkpoint 缺失: {config.DEFAULT_CHECKPOINT}")
        _model, _threshold = inference.load_model()
    return _model, _threshold


def _make_run_fn():
    """返回 run_fn(df, progress_cb) 供 JobManager 调用。"""
    model, threshold = _ensure_model()

    def run_fn(df, progress_cb=None):
        labels = df["Label"].values.astype(int) if "Label" in df.columns else None
        attacks = (df["Attack"].astype(str).values if "Attack" in df.columns
                   else np.array(["Benign"] * len(df)))
        ts_ms = (df["FLOW_START_MILLISECONDS"].values.astype("int64")
                 if "FLOW_START_MILLISECONDS" in df.columns else np.arange(len(df)))
        # 真实 NetFlow 字节/包列，供节点详情显示全量真值（缺列则置 0）。
        def _col(name):
            return (df[name].fillna(0).values.astype("int64")
                    if name in df.columns else np.zeros(len(df), dtype="int64"))
        feats = {"in_bytes": _col("IN_BYTES"), "out_bytes": _col("OUT_BYTES"),
                 "in_pkts": _col("IN_PKTS"), "out_pkts": _col("OUT_PKTS")}
        result = inference.run_inference(df, model, threshold, progress_cb=progress_cb)
        return {"result": result, "ts_ms": ts_ms, "attacks": attacks,
                "labels": labels, "feats": feats, "total_rows": len(df)}

    return run_fn


@app.get("/api/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None, "device": inference.DEVICE}


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(400, f"CSV 解析失败: {e}")
    try:
        inference.validate_columns(df)
    except inference.ColumnMismatchError as e:
        return JSONResponse(status_code=400,
                            content={"error": "列结构不符，需 NetFlow v3 格式",
                                     "missing": e.missing})
    job_id = _mgr.create_job(df, _make_run_fn())
    return {"job_id": job_id, "filename": file.filename,
            "total_rows": len(df), "status": "queued"}


@app.post("/api/jobs/sample")
def create_sample_job(sample_rows: int = 30000):
    """一键示例：读真实测试集前 sample_rows 行（演示用，避免 23.6 万行全跑拖慢首屏）。"""
    path = os.path.join(config.DATA_DIR, "NF-UNSW-NB15-v3-test-split.csv")
    if not os.path.exists(path):
        raise HTTPException(404, f"示例数据集不存在: {path}")
    df = pd.read_csv(path, nrows=sample_rows)
    job_id = _mgr.create_job(df, _make_run_fn())
    return {"job_id": job_id, "filename": f"NF-UNSW-NB15-v3-test-split(示例{sample_rows}行)",
            "total_rows": len(df), "status": "queued"}


@app.get("/api/jobs/{job_id}/progress")
async def progress(job_id: str):
    async def gen():
        while True:
            st = _mgr.get_status(job_id)
            yield {"data": json.dumps(st, ensure_ascii=False)}
            if st["stage"] in ("done", "error"):
                break
            await asyncio.sleep(0.4)

    return EventSourceResponse(gen())


@app.get("/api/jobs/{job_id}/replay")
def replay(job_id: str, model: str = "improved"):
    p = _mgr.get_replay(job_id, model)
    if p is None:
        raise HTTPException(404, "结果未就绪")
    return p


@app.get("/api/jobs/{job_id}/metrics")
def metrics(job_id: str, model: str = "improved"):
    m = _mgr.get_metrics(job_id, model)
    if m is None:
        raise HTTPException(404, "结果未就绪")
    return m


@app.post("/api/jobs/{job_id}/report")
def report(job_id: str):
    from server import aggregate, report as report_mod
    bundle = _mgr.get_raw(job_id)
    if not bundle:
        raise HTTPException(404, "结果未就绪")
    m = aggregate.build_metrics(bundle["result"], bundle["labels"])
    facts = report_mod.build_facts(bundle, m)
    ai_sections = report_mod.generate_ai_sections(facts)
    tz = timezone(timedelta(hours=8))
    return {
        "job_id": job_id,
        "generated_at": datetime.now(tz).isoformat(timespec="seconds"),
        "model": {
            "name": "自监督 Graph AutoEncoder",
            "type": "self-supervised",
            "dataset": config.DEFAULT_DATASET,
        },
        "facts": facts,
        "ai_sections": ai_sections,
    }




@app.get("/api/jobs/{job_id}/nodes/{ip}")
def node_detail(job_id: str, ip: str, model: str = "improved"):
    from server import aggregate
    b = _mgr.get_raw(job_id, "improved")
    if not b:
        raise HTTPException(404, "结果未就绪")
    return aggregate.node_detail(b["result"], b["ts_ms"], b["attacks"], ip)


@app.get("/api/jobs/{job_id}/edges/{src}/{dst}")
def edge_flows(job_id: str, src: str, dst: str, page: int = 0, size: int = 50,
               model: str = "improved"):
    from server import aggregate
    b = _mgr.get_raw(job_id, "improved")
    if not b:
        raise HTTPException(404, "结果未就绪")
    return aggregate.edge_flows(b["result"], b["ts_ms"], b["attacks"], src, dst, page, size)


@app.get("/")
def index():
    if os.path.exists(config.FRONTEND_HTML):
        return FileResponse(config.FRONTEND_HTML)
    raise HTTPException(404, "前端未构建：请先在 frontend/ 运行 `npm run build`")


# Vue 构建产物的静态资源（hash 命名的 js/css）。挂在 API 路由之后，避免遮蔽 /api。
# favicon.svg / icons.svg 等 public 资源也在 dist 根目录，一并由此目录托管。
if os.path.isdir(config.FRONTEND_DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(config.FRONTEND_DIST, "assets")), name="assets")
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")
