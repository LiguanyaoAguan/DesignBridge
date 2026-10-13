/**
 * 设计资源清单（assets.json）的**纯校验**层。
 *
 * 资源是设计交付的一部分，因此在**提交前**就必须能被校验器拒绝掉危险/超限的声明；
 * 渲染层不得依赖"文件一定安全"这个假设（另有净化做纵深防御）。
 *
 * 安全边界（逐条对应需求）：
 *  - 路径穿越：拒绝 `..`、绝对路径、盘符、反斜杠、NUL、URL 编码绕过
 *  - 任意本地文件读取：资源必须落在 `designs/<designId>/assets/` 之内（前缀 + 剩余段双重校验）
 *  - 外部不受信任 URL：path 只允许仓库内相对路径，禁止 scheme / `//host`
 *  - 体积失控：单资源上限 + 资源数量上限 + 声明总量上限
 *  - 格式与扩展名必须自洽（svg ↔ .svg；image ↔ .png/.jpg/.jpeg/.webp）
 *
 * 纯函数、零依赖，可脱离宿主单独测试。
 */

export const ASSET_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxAssets: 64,
  maxDeclaredBytes: 2 * 1024 * 1024,
  maxStringCodePoints: 512,
  maxErrors: 50,
});

export const ASSET_SCHEMA_VERSION = '1.0.0';

/** 资源 id：字母开头，字母数字点划下划线，<=64。用于被 preview 引用。 */
const ASSET_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** 资源种类 → 允许的扩展名。 */
const KIND_EXTENSIONS = Object.freeze({
  svg: Object.freeze(['.svg']),
  image: Object.freeze(['.png', '.jpg', '.jpeg', '.webp']),
});

/** 每类资源的默认体积上限（可被清单里的显式 maxBytes 收紧，但不能放宽）。 */
const KIND_DEFAULT_MAX_BYTES = Object.freeze({
  svg: 64 * 1024,
  image: 512 * 1024,
});

function add(errors, code, path, message) {
  if (errors.length < ASSET_LIMITS.maxErrors) errors.push({ code, path, message });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断一个声明路径是否安全且位于允许的资源目录内。
 * @param {unknown} value 清单里的 path
 * @param {string} assetsPrefix 形如 `designs/<id>/assets/`
 */
export function checkAssetPath(value, assetsPrefix) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > ASSET_LIMITS.maxStringCodePoints) return { ok: false, reason: 'too-long' };
  // 控制字符 / NUL
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'control-char' };
  // 反斜杠（Windows 风格穿越）与 scheme
  if (value.includes('\\')) return { ok: false, reason: 'backslash' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return { ok: false, reason: 'scheme' };
  // 网络路径（//host/...）
  if (value.startsWith('//')) return { ok: false, reason: 'protocol-relative' };
  // 绝对路径
  if (value.startsWith('/')) return { ok: false, reason: 'absolute' };
  // URL 编码绕过：解码后再判一次
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return { ok: false, reason: 'bad-encoding' };
  }
  if (decoded !== value && (decoded.includes('..') || decoded.startsWith('/') || decoded.includes('\\'))) {
    return { ok: false, reason: 'encoded-traversal' };
  }
  // 逐段校验：拒绝空段、`.`、`..`
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return { ok: false, reason: 'traversal' };
  }
  // 必须带容量上限
  if (!value.startsWith(assetsPrefix)) return { ok: false, reason: 'outside-assets-dir' };
  const rest = value.slice(assetsPrefix.length);
  if (rest.length === 0 || rest.includes('..')) return { ok: false, reason: 'outside-assets-dir' };
  return { ok: true, rest };
}

/**
 * 校验资源清单。
 * @param {unknown} value 解析后的 assets.json
 * @param {{ designId?: string }} [context]
 * @returns {{ ok: boolean, errors: Array<{code:string,path:string,message:string}>, assets: Map<string, object>, declaredBytes: number }}
 */
export function validateAssets(value, context = {}) {
  const errors = [];
  const assets = new Map();
  let declaredBytes = 0;

  const designId = typeof context.designId === 'string' && context.designId.length > 0 ? context.designId : null;
  const assetsPrefix = designId === null ? null : `designs/${designId}/assets/`;

  if (!isPlainObject(value)) {
    add(errors, 'invalid-shape', '$', '资源清单必须是对象');
    return { ok: false, errors, assets, declaredBytes };
  }
  if (value.assetSchemaVersion !== ASSET_SCHEMA_VERSION) {
    add(errors, 'unsupported-version', '$.assetSchemaVersion', `assetSchemaVersion 必须为 ${ASSET_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.assets)) {
    add(errors, 'invalid-shape', '$.assets', 'assets 必须是数组');
    return { ok: false, errors, assets, declaredBytes };
  }
  if (value.assets.length > ASSET_LIMITS.maxAssets) {
    add(errors, 'limit-exceeded', '$.assets', `资源数量必须为 0–${ASSET_LIMITS.maxAssets}`);
    return { ok: false, errors, assets, declaredBytes };
  }
  if (designId === null) {
    add(errors, 'unknown-design-id', '$', '缺少 designId，无法确定资源根目录');
    return { ok: false, errors, assets, declaredBytes };
  }

  value.assets.forEach((asset, index) => {
    const at = `$.assets[${index}]`;
    if (!isPlainObject(asset)) {
      add(errors, 'invalid-shape', at, '资源项必须是对象');
      return;
    }
    const { id, kind, path } = asset;
    if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) {
      add(errors, 'invalid-value', `${at}.id`, 'id 必须为字母开头的 1–64 位 [A-Za-z0-9._-]');
      return;
    }
    if (assets.has(id)) {
      add(errors, 'duplicate-id', `${at}.id`, `资源 id 重复：${id}`);
      return;
    }
    if (kind !== 'svg' && kind !== 'image') {
      add(errors, 'invalid-value', `${at}.kind`, 'kind 必须为 svg 或 image');
      return;
    }
    const pathCheck = checkAssetPath(path, assetsPrefix);
    if (!pathCheck.ok) {
      add(errors, 'unsafe-path', `${at}.path`, `资源路径不被允许（${pathCheck.reason}）：${String(path).slice(0, 80)}`);
      return;
    }
    const lower = path.toLowerCase();
    const extensions = KIND_EXTENSIONS[kind];
    if (!extensions.some(ext => lower.endsWith(ext))) {
      add(errors, 'format-mismatch', `${at}.path`, `kind=${kind} 的扩展名必须为 ${extensions.join(' / ')}`);
      return;
    }
    // 声明体积：只允许收紧，不允许超过该 kind 的硬上限
    let maxBytes = KIND_DEFAULT_MAX_BYTES[kind];
    if (asset.maxBytes !== undefined) {
      if (typeof asset.maxBytes !== 'number' || !Number.isInteger(asset.maxBytes) || asset.maxBytes <= 0) {
        add(errors, 'invalid-value', `${at}.maxBytes`, 'maxBytes 必须为正整数');
        return;
      }
      maxBytes = Math.min(maxBytes, asset.maxBytes);
    }
    if (asset.bytes !== undefined && (typeof asset.bytes !== 'number' || !Number.isInteger(asset.bytes) || asset.bytes < 0)) {
      add(errors, 'invalid-value', `${at}.bytes`, 'bytes 必须为非负整数');
      return;
    }
    declaredBytes += typeof asset.bytes === 'number' ? asset.bytes : 0;

    assets.set(id, {
      id,
      kind,
      path,
      maxBytes,
      bytes: typeof asset.bytes === 'number' ? asset.bytes : null,
      title: typeof asset.title === 'string' ? asset.title.slice(0, ASSET_LIMITS.maxStringCodePoints) : undefined,
      // 设计方尚未交付正式素材时，用 temporary 显式标注占位（渲染层与报告都要如实呈现）
      temporary: asset.temporary === true,
      source: typeof asset.source === 'string' ? asset.source.slice(0, ASSET_LIMITS.maxStringCodePoints) : undefined,
    });
  });

  if (declaredBytes > ASSET_LIMITS.maxDeclaredBytes) {
    add(errors, 'limit-exceeded', '$.assets', `声明总量 ${declaredBytes} 字节超过上限 ${ASSET_LIMITS.maxDeclaredBytes}`);
  }
  return { ok: errors.length === 0, errors, assets, declaredBytes };
}

/**
 * 校验 preview 里引用的资源 id 是否都已声明（缺失 → 可见错误，而不是静默空白）。
 * @returns {Array<{code:string,path:string,message:string}>}
 */
export function checkAssetReferences(preview, assets) {
  const errors = [];
  if (!isPlainObject(preview) || !Array.isArray(preview.pages)) return errors;
  const seen = new Set();
  const walk = (node, at) => {
    if (!isPlainObject(node)) return;
    const props = isPlainObject(node.props) ? node.props : {};
    // icon 用 asset，image 用 asset；两者都是资源引用
    if ((node.type === 'icon' || node.type === 'image') && typeof props.asset === 'string') {
      seen.add(props.asset);
      if (!assets.has(props.asset)) {
        add(errors, 'missing-asset', `${at}.props.asset`, `引用了未声明的资源：${props.asset}`);
      }
    }
    const children = node.children;
    if (Array.isArray(children)) children.forEach((child, index) => walk(child, `${at}.children[${index}]`));
  };
  (preview.pages || []).forEach((page, pageIndex) => {
    if (isPlainObject(page)) walk(page.root, `$.pages[${pageIndex}].root`);
  });
  return errors;
}
