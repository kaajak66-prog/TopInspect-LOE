"""后端配置：路径、特征列、模型超参（与 configs/NF-UNSW-NB15-v3.yaml 及 checkpoint 维度对齐）。"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 加载项目根目录下的 .env（若存在），让 DEEPSEEK_API_KEY 等变量生效。
# 不覆盖已存在的系统环境变量；缺少 python-dotenv 时静默跳过。
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(BASE_DIR, ".env"), override=False)
except ImportError:
    pass

DATA_DIR = os.path.join(BASE_DIR, "data")
CHECKPOINT_DIR = os.path.join(BASE_DIR, "checkpoints")
# Vue 构建产物目录（frontend/dist）。运行 `npm run build` 后由 FastAPI 静态托管。
FRONTEND_DIST = os.path.join(BASE_DIR, "frontend", "dist")
FRONTEND_HTML = os.path.join(FRONTEND_DIST, "index.html")

DEFAULT_DATASET = "NF-UNSW-NB15-v3"
# 优化后模型（主检测在用）：baseline 架构，干净训练，FPR≈0.02%。
DEFAULT_CHECKPOINT = os.path.join(CHECKPOINT_DIR, "TopInspect_NF-UNSW-NB15-v3_42.ckpt")

# 建图时从特征中排除的列（v3 规则，见 utils/dataloaders.py:153-164）
NON_FEATURE_COLS_V3 = [
    "IPV4_SRC_ADDR",
    "IPV4_DST_ADDR",
    "FLOW_START_MILLISECONDS",
    "FLOW_END_MILLISECONDS",
]
LABEL_COLS = ["Label", "Attack"]

# 49 个边特征（按 CSV 列顺序，去掉 IP/时间戳/标签后）。
# 已用真实表头核对：data/NF-UNSW-NB15-v3-test-split.csv（与全量同结构）共 55 列 -> 49 特征。
# 已用 checkpoint 核对：encoder.fc_neigh.weight = (49, 49)，edim_in = ndim_in = 49。
EDGE_FEATURES_V3 = [
    "L4_SRC_PORT", "L4_DST_PORT", "PROTOCOL", "L7_PROTO", "IN_BYTES", "IN_PKTS",
    "OUT_BYTES", "OUT_PKTS", "TCP_FLAGS", "CLIENT_TCP_FLAGS", "SERVER_TCP_FLAGS",
    "FLOW_DURATION_MILLISECONDS", "DURATION_IN", "DURATION_OUT", "MIN_TTL", "MAX_TTL",
    "LONGEST_FLOW_PKT", "SHORTEST_FLOW_PKT", "MIN_IP_PKT_LEN", "MAX_IP_PKT_LEN",
    "SRC_TO_DST_SECOND_BYTES", "DST_TO_SRC_SECOND_BYTES", "RETRANSMITTED_IN_BYTES",
    "RETRANSMITTED_IN_PKTS", "RETRANSMITTED_OUT_BYTES", "RETRANSMITTED_OUT_PKTS",
    "SRC_TO_DST_AVG_THROUGHPUT", "DST_TO_SRC_AVG_THROUGHPUT", "NUM_PKTS_UP_TO_128_BYTES",
    "NUM_PKTS_128_TO_256_BYTES", "NUM_PKTS_256_TO_512_BYTES", "NUM_PKTS_512_TO_1024_BYTES",
    "NUM_PKTS_1024_TO_1514_BYTES", "TCP_WIN_MAX_IN", "TCP_WIN_MAX_OUT", "ICMP_TYPE",
    "ICMP_IPV4_TYPE", "DNS_QUERY_ID", "DNS_QUERY_TYPE", "DNS_TTL_ANSWER",
    "FTP_COMMAND_RET_CODE", "SRC_TO_DST_IAT_MIN", "SRC_TO_DST_IAT_MAX",
    "SRC_TO_DST_IAT_AVG", "SRC_TO_DST_IAT_STDDEV", "DST_TO_SRC_IAT_MIN",
    "DST_TO_SRC_IAT_MAX", "DST_TO_SRC_IAT_AVG", "DST_TO_SRC_IAT_STDDEV",
]

# 模型超参，对齐 configs/NF-UNSW-NB15-v3.yaml 与 checkpoint 实测维度
MODEL_HPARAMS = {
    "edim_out": 96,
    "ae_embedding_dim": 48,
    "num_heads": 4,
    "num_layers": 1,
    "window_size": 512,
    "dropout": 0.0,      # 推理时无 dropout
    "ae_dropout": 0.0,
    "positional_encoding": "None",
    "agg_type": "mean",
    "mask_ratio": 0.0,   # 推理时不 mask
    "encoder_type": "baseline",
}

TOTAL_STEPS = 300          # 回放帧数，与前端一致
AE_BATCH_SIZE = 64

# DeepSeek（OpenAI 兼容）报告生成配置。API Key 不在此持有，仅 report.py 读环境变量。
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_TIMEOUT = float(os.environ.get("DEEPSEEK_TIMEOUT", "30"))
