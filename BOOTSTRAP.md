# DesignBridge v0.1 初始化与验证

## 安装
无需安装依赖。本阶段仅使用 Git 和 JSON 文件。

## 首次验证
1. 确认所有 JSON 可解析：`python -m json.tool protocol/manifest.json >/dev/null` 等。
2. 检查 `manifest.json` 的路径均存在。
3. DeepSeek Harness 从 GitHub 克隆或拉取本仓库。
4. DeepSeek 在隔离分支写入脱敏的连通性结果，提交前先确认权限与目标分支。
5. ChatGPT 读取提交的 `handoff/result.json`，核对任务 ID 和状态。

## 注意
- 不要将 InnerRec Studio 私有仓库文件复制到公开仓库。
- 不要直接向 main 提交未经审阅的生成内容。
- 本仓库的 UI 数值均为示例，不是原应用的设计真值。
