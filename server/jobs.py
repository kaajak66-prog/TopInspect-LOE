"""任务管理：建 job、后台线程跑推理、维护进度、缓存结果。单机内存版。"""
import threading
import uuid

from server import aggregate


class JobManager:
    def __init__(self):
        self._jobs = {}      # job_id -> {stage, pct, rows_done, total_rows, error}
        self._results = {}   # job_id -> 优化后模型 bundle（主检测结果）
        self._lock = threading.Lock()

    def create_job(self, df, run_fn):
        """run_fn(df, progress_cb) -> {result, ts_ms, attacks, labels, total_rows}。"""
        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._jobs[job_id] = {"stage": "queued", "pct": 0, "rows_done": 0,
                                  "total_rows": len(df), "error": None}
        t = threading.Thread(target=self._worker, args=(job_id, df, run_fn), daemon=True)
        t.start()
        return job_id

    def _set(self, job_id, **kw):
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(kw)

    def _worker(self, job_id, df, run_fn):
        try:
            self._set(job_id, stage="解析数据流", pct=10)

            def cb(pct, rows):
                self._set(job_id, stage="神经网络推理", pct=pct, rows_done=rows)

            bundle = run_fn(df, progress_cb=cb)
            self._set(job_id, stage="构建威胁图谱", pct=90)
            with self._lock:
                self._results[job_id] = bundle
            self._set(job_id, stage="done", pct=100)
        except Exception as e:  # 推理/聚合任何错误 → error 阶段
            self._set(job_id, stage="error", error=str(e))

    def get_status(self, job_id):
        with self._lock:
            return dict(self._jobs.get(job_id, {"stage": "error", "error": "job 不存在"}))

    def _bundle(self, job_id, model="improved"):
        """按模型返回 bundle（主检测结果）。model 参数保留以兼容调用方，恒走主结果。"""
        with self._lock:
            return self._results.get(job_id)

    def get_replay(self, job_id, model="improved"):
        b = self._bundle(job_id, model)
        if not b:
            return None
        return aggregate.build_replay_payload(b["result"], b["ts_ms"], b["attacks"],
                                               feats=b.get("feats"))

    def get_metrics(self, job_id, model="improved"):
        b = self._bundle(job_id, model)
        if not b:
            return None
        return aggregate.build_metrics(b["result"], b["labels"])

    def get_raw(self, job_id, model="improved"):
        return self._bundle(job_id, model)
