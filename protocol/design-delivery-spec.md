# DesignBridge 设计交付规格（v1）

**给谁看**：生成设计稿的 AI（ChatGPT）与执行交付的人。
**目的**：让一次生成就通过校验，避免"画得出来、导不进去"。

> 本文的每一条都摘自**代码**，不是约定俗成的说法：
> - 契约规则：`dsh-plugin/src/model/contract-schema.mjs`（与 `dsh-plugin/client.js` 内联版本逐条对齐）
> - 预览规则：`dsh-plugin/src/model/preview-schema.mjs`
> - 提交前校验：`node dsh-plugin/scripts/validate-design.mjs`

---

## 一、交付物：两份文件

| 文件 | 路径 | 说明 |
|---|---|---|
| 设计契约 | `protocol/design-contract.json` | 声明"当前设计是谁"（designId / designVersion / 画布方向 / 设计 token） |
| 组件预览 | `designs/<designId>/preview.json` | 描述页面与组件树 |

**`<designId>` 必须与契约里的 `designId` 完全一致。** 路径是**约定**，不由 manifest 声明。

---

## 二、设计契约字段

### 必填

| 字段 | 类型 | 规则 |
|---|---|---|
| `schemaVersion` | string | 非空；当前 `"1.0.0"` |
| `designId` | string | 非空；**同时决定 preview 的目录名** |
| `designVersion` | string | 非空；**必须与 preview 的同名字段一致** |
| `platform` | string | 非空；如 `"android-compose"` |
| `screenId` | string | 非空；**必须是 preview 里某个 page 的 `id`** |
| `designTokens` | object | 值只能是 **string 或 number**；string 也受长度上限 |
| `layout` | object | `orientation`(非空 string) + `regions`(string[]) |
| `changeScope` | object | `allowed`(string[]) + `protected`(string[]) —— **两个都必须存在** |
| `referenceAssets` | array | 必须存在（可为空数组） |

### 可选

| 字段 | 类型 |
|---|---|
| `description` | string |

> **`layout.orientation` 会与 preview 每个 page 的 `viewport.orientation` 交叉校验**，必须一致。

---

## 三、预览文件结构

```jsonc
{
  "previewSchemaVersion": "1.0.0",
  "designId": "<与契约一致>",
  "designVersion": "<与契约一致>",
  "pages": [ /* 1 – 32 个 page */ ]
}
```

**page**：

| 字段 | 规则 |
|---|---|
| `id` | 匹配 `^[A-Za-z][A-Za-z0-9._-]{0,63}$`，**页间唯一** |
| `title` | 非空字符串（≤120 码点） |
| `viewport` | `{ widthDp, heightDp, orientation }`；`orientation` 必须等于契约的 `layout.orientation` |
| `root` | **必须是 `type: "frame"`** |

**节点**：只允许这 5 个字段 —— `id` / `type` / `props` / `layout` / `children`。
**多一个字段就报 `unknown-field`。**

---

## 四、九类组件（props 白名单）

`props` 里**只能出现下表中的键**，多一个即失败；`必填` 缺失也失败。

| `type` | 必填 | 可选 | 取值约束 | children |
|---|---|---|---|---|
| `frame` | `direction`, `layoutMode` | `gap`, `padding` | `direction`: `row`\|`column`；`layoutMode`: `flow`\|`absolute`；`gap`/`padding`: 0–512 | 任意 |
| `text` | `text` | `size`, `weight`, `tone` | `size`: 1–256；`weight`: `normal`\|`medium`\|`semibold`\|`bold`；`tone`: `primary`\|`secondary`\|`tertiary` | **禁止** |
| `button` | `label` | `variant`, `disabled` | `variant`: `primary`\|`ghost`；`disabled`: boolean | **禁止** |
| `card` | `title` | `subtitle` | 均为字符串 | 任意 |
| `list` | — | `dense` | `dense`: boolean | **只能含 `list-item`，且至少 1 个** |
| `list-item` | `label` | `meta`, `trailing` | 均为字符串 | **禁止** |
| `badge` | `label` | `tone` | `tone`: `primary`\|`secondary`\|`tertiary`\|`success`\|`warning`\|`danger` | **禁止** |
| `divider` | — | — | — | **禁止** |
| `image-placeholder` | `label` | — | — | **禁止** |

---

## 五、布局约束（`layout`）

**两种，二选一：**

```jsonc
"layout": { "mode": "flow" }                                       // 流式（推荐，默认）
"layout": { "mode": "absolute", "x": 0, "y": 0, "width": 300, "height": 200 }
```

| 规则 | 说明 |
|---|---|
| `mode: "flow"` | **只能有 `mode` 一个键**；`frame` 子节点按 `direction` 排布 |
| `mode: "absolute"` | 必须有 `x`/`y`/`width`/`height`；`width`/`height` **> 0 且 ≤ 4096**；`x`/`y` 绝对值 ≤ 4096 |
| **absolute 只能作为 `layoutMode:"absolute"` 的 frame 的直接子节点** | 放错层级报 `layout-mode-conflict` |
| `layout` 可省略 | 但若父级是 `absolute` frame，**子节点必须声明 absolute** |

> ⚠️ 当前实现**只支持浅层绝对定位**。"整页像素级摆位"请用 `layoutMode:"absolute"` 的 frame
> 作为容器，把要精确摆放的节点放成它的**直接子节点**。

---

## 六、最容易踩的坑（按真机/测试实际遇到排序）

1. **节点多了字段** —— 只允许 `id`/`type`/`props`/`layout`/`children`
2. **`props` 里塞了 `color`/`radius`/`shadow` 之类** —— 这些**字段根本不存在**，会被判 `unknown-field`
   （当前 schema 不支持任意颜色/圆角/阴影/字体族；这些属于后续版本）
3. **`list` 里放了非 `list-item`** 或 `list` 没有 children
4. **叶节点带了 `children`**（`text`/`button`/`badge`/`divider`/`image-placeholder`/`list-item` 都禁止）
5. **`root` 不是 `frame`**
6. **三处 `designVersion` 不一致**（contract / preview / manifest）
7. **`screenId` 在 pages 里找不到对应 page**
8. **`viewport.orientation` 与 `layout.orientation` 不一致**
9. **绝对定位放错层级**（不是 absolute frame 的直接子节点）
10. **节点 `id` 重复**或格式不合法

---

## 七、上限

| 项 | 上限 |
|---|---|
| preview 文件大小 | 512 KB |
| 页面数 | 32 |
| 每页节点数 | 2000 |
| 树深度 | 12 |
| 单个字符串 | 4096 码点 |
| 契约文件大小 | 256 KB |
| `designTokens` 条目 | 512 |

---

## 八、一个**可通过校验**的完整示例

仓库里已有一份真实可跑的：

- `protocol/design-contract.json` → `demo-player`
- `designs/demo-player/preview.json` → 1 页 / 14 节点 / 覆盖**全部 9 类组件**

骨架（完整内容见文件）：

```jsonc
{
  "previewSchemaVersion": "1.0.0",
  "designId": "demo-player",
  "designVersion": "demo-0.1",
  "pages": [{
    "id": "player",
    "title": "播放器",
    "viewport": { "widthDp": 1280, "heightDp": 800, "orientation": "landscape" },
    "root": {
      "id": "root", "type": "frame",
      "props": { "direction": "row", "layoutMode": "flow", "gap": 12, "padding": 16 },
      "children": [
        { "id": "sidebar", "type": "card", "props": { "title": "曲库", "subtitle": "我的音乐" },
          "layout": { "mode": "flow" },
          "children": [
            { "id": "sidebar-count", "type": "badge", "props": { "label": "12 首", "tone": "success" }, "layout": { "mode": "flow" } },
            { "id": "sidebar-divider", "type": "divider", "props": {}, "layout": { "mode": "flow" } }
          ] },
        { "id": "stage", "type": "card", "props": { "title": "播放器", "subtitle": "正在播放" },
          "layout": { "mode": "flow" },
          "children": [
            { "id": "stage-cover", "type": "image-placeholder", "props": { "label": "专辑封面" }, "layout": { "mode": "flow" } },
            { "id": "stage-track", "type": "text", "props": { "text": "夜航西飞", "size": 22, "weight": "semibold", "tone": "primary" }, "layout": { "mode": "flow" } },
            { "id": "stage-play", "type": "button", "props": { "label": "暂停", "variant": "primary", "disabled": false }, "layout": { "mode": "flow" } }
          ] }
      ]
    }
  }]
}
```

---

## 九、交付前自检（**必做**）

```bash
node dsh-plugin/scripts/validate-design.mjs
```

- **退出码 0** → 可以提交
- **退出码 1** → **禁止提交**，按输出的**路径化错误**逐条修

错误形如：

```
[unknown-component-type] designs/demo-player/preview.json#$.pages[0].root.children[0].type — 未知组件类型
```

`#` 前是文件、`#` 后是 JSONPath —— 可以直接定位并回贴给生成方迭代。

---

## 十、常见错误码

| code | 含义 |
|---|---|
| `unknown-field` | 出现白名单外的字段 |
| `required-field` | 缺必填字段 |
| `type-mismatch` | 类型不对 |
| `invalid-value` | 取值不在允许范围（枚举/范围/格式） |
| `unknown-component-type` | `type` 不在九类白名单内 |
| `invalid-nesting` | 嵌套违规（叶节点带 children、list 含非 list-item、root 非 frame） |
| `layout-mode-conflict` | 绝对定位层级错误 |
| `duplicate-node-id` / `duplicate-page-id` | ID 重复 |
| `limit-exceeded` | 超上限（页数/节点数/深度/条目数） |
| `unsupported-version` | 协议版本不认识 |
| `design-id-mismatch` / `design-version-mismatch` | 契约与预览不一致 |
| `screen-id-mismatch` | `screenId` 在 pages 里找不到 |
| `orientation-mismatch` | viewport 方向与契约不符 |
| `missing-file` | 交付文件不存在 |
| `invalid-json` | JSON 语法错误 |
| `input-too-large` | 文件超大小上限 |

---

## 十一、当前**不支持**（不要写进文件，会被判 `unknown-field`）

颜色 / 描边 / 阴影 / 透明度 / 圆角 / 字体族 / 图标 / 图片资源 / 渐变 / 边框 /
hover·pressed 等交互态 / 多层嵌套的绝对定位。

> 这些属于后续版本（v0.5+）的扩容范围。**本轮不要用它们**，否则一定校验失败。
