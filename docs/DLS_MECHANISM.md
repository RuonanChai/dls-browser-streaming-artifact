# DLS 全套工作机制

本文档描述本 artifact 所实现的 **Demand Lookahead Scheduling (DLS)**：在 Spark 2.0 浏览器流式 3D Gaussian Splatting 中，如何利用 fetcher 管线的空闲窗口预取即将需要的 chunk，且**不抢占**当前帧的可见 demand。

---

## 1. 问题背景

Spark-OD（on-demand）每帧只为**当前可见** LOD chunk 发起 HTTP Range 请求。相机快速移动时，chunk 在变为 visible 之后才开始 fetch → parse → GPU upload，首屏与质量爬坡受 **critical-path 网络等待** 限制。

DLS 的思路：在 fetcher 有空闲 slot、且当前没有 pending demand 的**瞬间**，向队列尾部追加最多 K 个**顺序** lookahead chunk，提前拉取 bytes。关键约束是 **gated**：lookahead 绝不能与正常 demand 竞争 fetcher slot。

---

## 2. 代码位置

| 模块 | 文件 | 职责 |
|------|------|------|
| 队列重建 | `src/SparkRenderer.ts` | 每帧根据视锥/LOD 重建 `pager.fetchPriority` |
| 调度 + gate | `src/SplatPager.ts` → `driveFetchers()` | lookahead 入队、启动 fetcher、完成回调 |
| 运行时 K | `window.__sparkSdlK` | 0 = Spark-OD；4 = 论文 DLS |
| 试验注入 | `scripts/lib/local_stutter_ablation_cell.mjs` | Playwright `addInitScript` 设置 `__sparkSdlK` |
| chunk 时间线 | `scripts/lib/proactive_chunk_probe.js` | 记录 demand/fetch/parse/upload 事件 |
| 网络审计 | `vrc-paper/experiments/cdp_network_audit.mjs` | 逐请求 timing（含 `download_ms`） |

---

## 3. 数据结构

### 3.1 `fetchPriority`

```typescript
fetchPriority: { splats: PagedSplats; chunk: number }[]
```

有序列表，**index 0 优先级最高**。`driveFetchers()` 从队首取尚未 in-flight 的条目，最多填满 `numFetchers`（Spark 默认 3）个并行 HTTP fetcher。

### 3.2 运行时旋钮

```javascript
window.__sparkSdlK = 4;   // lookahead 深度 K
window.__sdlStats = {     // 可选诊断计数器
  lookahead_enqueued, lookahead_gated_off, drive_calls, ...
};
```

Harness 按 baseline 注入：

| baseline | `sdl_k` |
|----------|---------|
| spark_od | 0 |
| dls | 4 |
| dls_l | 2 |
| dls_a | 8 |

---

## 4. 每帧 demand 路径（SparkRenderer）

渲染循环中（简化）：

1. 遍历 paged splat meshes，收集当前**可见** chunk → 写入新的 `fetchPriority`（chunk 0 或具体 LOD index）。
2. 调用 `pager.driveFetchers()`。

**重要：** `fetchPriority` 每帧**整表替换**，不是增量更新。因此：

- 当前帧所有 visible demand 始终在队首；
- 上一帧入队的 lookahead 若 chunk 已不可见，会在下一帧被丢弃（可能 wasted，计入 `__sdlStats.lookahead_wasted`）。

---

## 5. `driveFetchers()` 算法（SplatPager）

### 5.1 阶段 A — Gated lookahead 入队

当 `sdlK > 0` 时：

```
normalDemandCount = fetchPriority.length
activeFetchers    = fetchers.length   // 已启动未完成
pipelineIdle      = (activeFetchers === 0) AND (normalDemandCount === 0)
```

**Strict gate：** 仅当 `pipelineIdle === true` 才追加 lookahead。

对 `fetchPriority` 中每个 `{splats, chunk}`（此时列表只含本帧 demand，gate 保证为空时才会执行 lookahead 分支——实际上 gate 为真时 demand 列表为空，lookahead 从**上一帧 demand 上下文**通过遍历当前 priority 推导；实现上在 idle 时对现有 priority 条目扩展 c+1…c+K）：

- 读取 RAD metadata 中 chunk `c+1 … c+K` 的字节范围；
- 跳过已在 `loadedChunks` / 已在队列 / 已在 fetchers 的 chunk；
- 将新条目 **`push` 到 `fetchPriority` 尾部**（demand 之后）；
- 总数受 `min(sdlK, availableSlots)` 限制。

若 gate 关闭（有 pending demand 或 in-flight fetch）：

- 不追加 lookahead；
- `__sdlStats.lookahead_gated_off++`。

### 5.2 阶段 B — 启动 fetcher

按 `fetchPriority` 顺序扫描：

- 对每个 `{splats, chunk}`，若未加载且未 in-flight，创建 fetcher；
- 直到 in-flight 数达到 `numFetchers` 或队列耗尽。

Fetcher 完成回调中会再次调用 `driveFetchers()`，释放 slot 后继续服务队首 demand。

### 5.3 优先级语义

| 类型 | 队列位置 | 抢占 |
|------|----------|------|
| Visible demand | 队首（每帧重建） | — |
| Lookahead | 队尾（gate 通过后 append） | 永不抢占 demand |

---

## 6. Yield 与 in-flight lookahead

Fetcher 并行度固定为 3。若某一帧 gate 通过并入队 K=4 个 lookahead，其中 3 个立即 in-flight，第 4 个 pending；**下一帧**新的 visible demand 重建 `fetchPriority` 时：

- 新 demand 在队首；
- 但 3 个 lookahead fetch **不可 cancel**（已在 flight）；
- 新 demand 的 fetcher 启动需等待 slot 释放 → **DLS yield**。

论文中 DLS 偶发高于 Spark-OD 的 case 多源于此机制，而非 gate 逻辑错误。

---

## 7. Spark-OD 对照（K=0）

`sdlK === 0` 时，`driveFetchers()` 跳过整个 lookahead 分支，行为与未打补丁的 Spark on-demand 一致（仅 serve 当前 `fetchPriority` 中的 visible chunk）。

---

## 8. 测量 harness 流程

```
run.mjs
  └─ expandTrials(experiment_matrix)
  └─ trial_cell.mjs
       └─ runAblationCell (Playwright)
            ├─ addInitScript: __sparkSdlK
            ├─ ablation HTML + chunk probe + CDP auditor
            ├─ trace_replay (orbit / burst_turn / …)
            └─ 输出 cdp_network_audit.csv + probe snapshot
       └─ cdp_enrich.mjs: 对齐 CDP 与 chunk_states
       └─ per_trial_json/*.json
analyze.mjs → dls_summary.csv
```

### 8.1 关键指标（trial JSON）

| 字段 | 含义 |
|------|------|
| `first_visible_splat_ms` | 冷启动到首个 splat 可见 |
| `time_to_1M_visible_splats_ms` | 可见 splat 数达到 1M |
| `miss100` / `miss50` | chunk ready 晚于 demand 的比例（100ms / 50ms deadline） |
| `cdp_net_p50_ms` | CDP 记录的 HTTP `download_ms` p50（裸网络，不含排队） |
| `fetch_p50_ms` | 同上或 chunk_state 差分 fallback |
| `blank_ratio` | 无可见 splat 时间占比 |

### 8.2 柱图口径提醒（与 writing repo 出图脚本相关）

- **809 ms 类 `T_fetch`**：demand 锚定的 fetch 完成中位数（含 fetcher 排队）。
- **189 ms 类 `net_p50`**：CDP 单请求 `download_ms` p50。
- 柱体三段 median 之和 ≠ FV/T1M；Remote upload median 可低于 Edge。

本 artifact **不**包含 gap decomposition / demand timeline 出图脚本；仅有原始 trial JSON + CDP CSV。

---

## 9. 实验矩阵（artifact 内）

`config/ready_single_user/experiment_matrix.json` 仅含：

- **Baselines：** `spark_od`, `dls`, `dls_l`, `dls_a`
- **Phases：** `dls-main-burst-cos-n5`, `dls-trace-robustness-gated`, `dls-safety-strict-gate`
- **Delivery：** 默认 `remote_cos`（环境变量 `REMOTE_COS_URL`）

不含 PRoGS、SGSS、READY、Oracle、failed-approaches 等 phase。

---

## 10. 与 READY / proactive prefetch 的边界

本 artifact ** deliberately 移除**：

- `proactive_prefetch_controller.js` 及 READY 模块栈
- Oracle demand trace 与 reference 生成
- `generate_paper_reports.mjs` 及 markdown/HTML 报告合成

`proactive_chunk_probe.js` 文件名沿用历史原因；在本仓库中仅作 **chunk 级计时 probe**，不驱动任何 proactive 下载策略。

---

## 11. 复现检查清单

1. `npm run build` 后确认 `dist/spark.module.js` 含 DLS gate 代码。
2. 单次 smoke：`run.mjs --phase=dls-main-burst-cos-n5 --trials=1 --methods=spark_od,dls`
3. 检查 `per_trial_json` 中 `sdl_k` 与 baseline 一致。
4. 检查 `cdp_rad_206_count >= 3` 且 `hard_gate_passed: true`。
5. 对比同 batch 内 Spark-OD vs DLS 的 `first_visible_splat_ms` / `miss100`（跨天绝对值不可比，看 delta）。
