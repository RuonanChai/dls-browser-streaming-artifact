# DLS Browser Streaming — Anonymous Experiment Artifact

本仓库仅包含 **Demand Lookahead Scheduling (DLS)** 的浏览器端实现与最小化测量 harness，用于在 Spark 2.0 上复现实验。**不含**论文出图脚本、READY/Oracle 预取栈、`generate_paper_reports.mjs` 等报告生成代码。

详细机制说明见 [`docs/DLS_MECHANISM.md`](docs/DLS_MECHANISM.md)。

---

## 仓库结构

```
overlay/
  src/
    SplatPager.ts          # DLS gate + lookahead 入队（driveFetchers）
    SparkRenderer.ts       # 每帧重建 fetchPriority（可见 chunk 在队首）
  config/ready_single_user/
    experiment_matrix.json # 仅 DLS 相关 phase（Spark-OD + DLS 变体）
  scripts/ready_single_user/
    run.mjs                # 批量 trial 调度
    trial_cell.mjs         # 单次 trial（Playwright + CDP）
    analyze.mjs            # 汇总 per_trial_json → dls_summary.csv
    constants.mjs          # baseline 定义（spark_od, dls, dls_l, dls_a）
    delivery.mjs           # 资产 URL 解析（环境变量 / matrix）
    cdp_enrich.mjs         # CDP 与 chunk probe 对齐
    matrix.mjs, gates.mjs, trace_replay.mjs, ...
  scripts/lib/
    local_stutter_ablation_cell.mjs   # 浏览器 ablation 主循环
    local_stutter_ablation_html.mjs   # 注入 chunk 计时 probe（无 READY）
    proactive_chunk_probe.js          # chunk 级 fetch/parse/upload 时间线
    ablation_*.js, local_stutter_*.mjs
  vrc-paper/experiments/
    cdp_network_audit.mjs, audit_io.mjs
install_overlay.sh         # 将 overlay 复制到 Spark 源码树
docs/DLS_MECHANISM.md      # DLS 全套工作机制（推荐阅读）
```

**不包含：** LaTeX、`plot_*.py`、截图合成、原始 `paper_materials/` 输出（运行实验后本地生成）。

---

## 前置条件

| 组件 | 要求 |
|------|------|
| Node.js | ≥ 18 |
| Spark 2.0 | 公开仓库 [sparkjs.dev](https://sparkjs.dev/)，`npm install && npm run build` 可成功 |
| Playwright | 随 Spark 依赖安装 |
| GPU | 建议 NVIDIA + 物理 Chrome（harness 默认 RTX 类笔记本参数） |
| 远程资产 | 支持 HTTP Range (206) 的 `.rad` URL（论文默认 Coit Tower 40M LOD） |
| 可选 | `VRC_RAD_MANIFEST_CSV` — chunk 字节范围 manifest（CDP 对齐用） |

---

## 快速开始

### 1. 克隆 Spark 与本 artifact

```bash
git clone https://github.com/sparkjsdev/spark.git spark-dls-eval
git clone <THIS_ANONYMOUS_REPO_URL> dls-artifact
```

### 2. 安装 overlay

```bash
bash dls-artifact/install_overlay.sh spark-dls-eval
cd spark-dls-eval
npm install
npm run build
```

`install_overlay.sh` 会覆盖 Spark 中的 `src/SplatPager.ts`、`src/SparkRenderer.ts`，并安装 `scripts/ready_single_user/` 与 `scripts/lib/` 下的 harness 文件。

### 3. 配置交付 URL

通过环境变量（推荐）或编辑 `config/ready_single_user/experiment_matrix.json`：

```bash
# 远程 COS / 对象存储（论文主结果）
export REMOTE_COS_URL="https://your-bucket.cos.ap-region.myqcloud.com/coit-40m-sh1-lod.rad"

# 可选：LAN edge（safety phase 或本地对照）
export EDGE_SERVER_HOST="10.x.x.x"
export EDGE_ASSET_URL="http://${EDGE_SERVER_HOST}:8090/examples/streaming-lod/coit-40m-sh1-lod.rad"

# chunk 字节范围 manifest（CDP ↔ chunk 对齐）
export VRC_RAD_MANIFEST_CSV="/path/to/rad_manifest.csv"
```

### 4. 运行实验 batch

在 Spark 仓库根目录：

```bash
# 主结果：burst_turn trace，n=5，Spark-OD vs DLS / DLS-L / DLS-A
node scripts/ready_single_user/run.mjs --phase=dls-main-burst-cos-n5 --trials=5

# 仅跑 Spark-OD 与 DLS(K=4)
node scripts/ready_single_user/run.mjs --phase=dls-main-burst-cos-n5 --trials=5 --methods=spark_od,dls

# Trace 鲁棒性（4 traces × 2 baselines × n=3）
node scripts/ready_single_user/run.mjs --phase=dls-trace-robustness-gated --trials=3

# Safety：低延迟 / 无 throttle 下 DLS 不劣化 Spark-OD
node scripts/ready_single_user/run.mjs --phase=dls-safety-strict-gate --trials=3
```

输出目录默认：`paper_materials/dls_eval_v1/runs/<phase>/`

每个 trial 产生：

- `per_trial_json/<trial_id>.json` — 汇总指标
- `per_trial_runs/<trial_id>/cdp_network_audit.csv` — CDP 逐请求网络审计
- `per_trial_runs/<trial_id>/` — Playwright trace、probe 快照等

### 5. 汇总指标（CSV，非论文报告）

```bash
node scripts/ready_single_user/analyze.mjs \
  --batchDir=paper_materials/dls_eval_v1/runs/dls-main-burst-cos-n5
```

生成 `dls_summary.csv`：按 phase × baseline 聚合 first-visible、T1M、miss100、CDP net_p50 等。

---

## Baseline 与运行时参数

| baseline_id | 名称 | `window.__sparkSdlK` | 含义 |
|-------------|------|----------------------|------|
| `spark_od` | Spark-OD | 0 | Spark 原生 on-demand，无 lookahead |
| `dls` | DLS | 4 | 论文主配置（gated lookahead） |
| `dls_l` | DLS-L | 2 | K 消融（浅 lookahead） |
| `dls_a` | DLS-A | 8 | K 消融（深 lookahead） |

Harness 在 Playwright `addInitScript` 中注入 `window.__sparkSdlK`（见 `local_stutter_ablation_cell.mjs`）。**不**启用 READY、Oracle 或 proactive prefetch controller。

---

## 实验 Phase 一览

| Phase key | 内容 |
|-----------|------|
| `dls-main-burst-cos-n5` | 主结果：remote COS，`burst_turn`，5 trials × 4 baselines |
| `dls-trace-robustness-gated` | 4 条 camera trace，Spark-OD vs DLS，各 3 trials |
| `dls-safety-strict-gate` | `LAN-like` / `No-Throttle` 网络 profile，验证 gated DLS 安全性 |

---

## DLS 实现要点（摘要）

完整说明见 [`docs/DLS_MECHANISM.md`](docs/DLS_MECHANISM.md)。

1. **每帧 demand 重建**（`SparkRenderer.ts`）：按当前视锥可见性重建 `fetchPriority`，可见 chunk 排在队首。
2. **Strict gate lookahead**（`SplatPager.driveFetchers()`）：仅当 `activeFetchers === 0` 且 `fetchPriority.length === 0`（管线完全空闲）时，在队尾追加最多 K 个连续 chunk（c+1 … c+K）。
3. **不抢占 demand**：lookahead 永远在队尾；in-flight 的 lookahead 占满 3 个 fetcher slot 时，新 demand 需排队（论文中的 yield 来源）。
4. **测量**：chunk probe 记录 demand / fetch / parse / upload 时间戳；CDP 记录裸 HTTP `download_ms`（net_p50）。

---

## 匿名投稿

见 [`ANONYMOUS_SUBMISSION.md`](ANONYMOUS_SUBMISSION.md)。建议仓库名避免论文标题/作者关键词，例如 `dls-browser-streaming-artifact`。

---

## 故障排查

| 现象 | 检查项 |
|------|--------|
| `No 206/rad activity` | 资产 URL 可达、支持 Range；`curl -I` 返回 206/200 |
| CDP audit 为空 | `VRC_TRACE_CHROME` 未设为 `0`；Chrome 能启动 |
| chunk 对齐差 | 设置 `VRC_RAD_MANIFEST_CSV` |
| SwiftShader gate fail | 使用物理 GPU + 非 headless Chrome |
| 端口冲突 | 重启或清理残留 Chrome / 本地 proxy 进程 |

---

## License

MIT — 见 [LICENSE](LICENSE)。Spark 上游许可证独立。
