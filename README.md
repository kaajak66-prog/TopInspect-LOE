# TopInspect-LOE · 拓察无监督研究版

TopInspect-LOE 是基于 TopInspect 的无监督网络异常检测研究版本。项目将 NetFlow
通信记录构造成主机通信图，通过图编码器与 Transformer Autoencoder 学习流量的
正常模式，并利用重构误差识别异常通信。

本仓库在原项目基础上保留了完整的前后端检测链路，并增加了 LOE/MAD
无监督训练、无图编码器消融实验、报告事实约束以及前端交互回归测试。

上游项目：[kaajak66-prog/TopInspect](https://github.com/kaajak66-prog/TopInspect)

## 主要内容

- FastAPI 检测任务、SSE 进度、结果回放和分析报告接口
- Vue 3、D3.js 网络拓扑与安全态势前端
- E-GraphSAGE 与 Transformer Autoencoder 检测模型
- `utils/trainers_unsupervised.py`：LOE/MAD 无监督训练逻辑
- `configs/loe_v2_baseline.yaml`：LOE 实验配置
- `PlainAE` / `NoGraphEncoder`：去除图编码器的消融实现
- 前端布局、镜像展开和拓扑缩放回归测试

## 项目结构

```text
TopInspect-LOE/
├── configs/                 # TopInspect 与 LOE 训练配置
├── data/
│   └── pyg_graph_data/      # 推理所需的特征归一化器
├── frontend/                # Vue 3 前端源码与回归测试
├── models/                  # 图编码器、Transformer AE 与消融模型
├── server/                  # FastAPI、推理、聚合、任务和报告
├── utils/                   # 数据加载器及有监督/无监督训练器
├── main.py                  # 模型训练入口
├── pyproject.toml
└── uv.lock
```

## 安装

环境要求：Python 3.11、Node.js 20+。当前 Python 锁文件默认面向 Windows 和
CUDA 12.4；CPU 环境需将 PyTorch/PyG 安装源替换为对应的 CPU 构建。

```bash
uv sync

cd frontend
npm ci
npm run build
cd ..
```

## 模型与数据

为控制仓库体积并避免提交实验数据，本仓库不包含模型权重和测试 CSV。运行检测前，
请自行准备并放置：

```text
checkpoints/TopInspect_NF-UNSW-NB15-v3_42.ckpt
data/NF-UNSW-NB15-v3-test-split.csv        # 可选演示数据
```

特征归一化器保存在：

```text
data/pyg_graph_data/NF-UNSW-NB15-v3/scaler.pkl
```

请仅使用有权分析的网络流量，并在上传或共享数据前完成必要的去标识化。

## 启动

Windows 可运行：

```text
启动.bat
```

也可以手动启动：

```bash
uv run uvicorn server.api:app --host 127.0.0.1 --port 8000
```

浏览器访问 `http://127.0.0.1:8000`。

## 无监督训练

LOE/MAD 训练逻辑位于 `utils/trainers_unsupervised.py`，实验参数位于
`configs/loe_v2_baseline.yaml`。完整训练需要自行准备 NF-UNSW-NB15-v3 数据集。

基础 TopInspect 训练入口：

```bash
uv run python main.py
```

## AI 分析报告

复制 `.env.example` 为 `.env`，并按需设置 DeepSeek API Key：

```dotenv
DEEPSEEK_API_KEY=your_api_key_here
```

`.env` 已被忽略，不应提交到版本库。未配置远程 AI 服务时，系统会使用基于真实检测
指标的本地降级摘要。

## 许可证

本项目使用 MIT License。该版本基于 TopInspect 修改，原项目及第三方数据、模型和
依赖仍分别受其许可证与使用条款约束。
