/**
 * design-contract v1 校验（**供脚本与测试复用**）。
 *
 * ⚠️ 为什么这里要"再写一份"：
 *   `dsh-plugin/client.js` 是**单文件**，由 Harness 的 classic client loader 直接执行，
 *   **不能 import 任何模块**（侧车 bundle 实测不可用，见 preview-bundle.mjs 的说明）。
 *   所以 client.js 内部那份契约校验是**内联**的，无法被 CLI 复用。
 *
 * 本模块的规则与 client.js 内的 `validateContract` **逐条对齐**，只是把错误做成
 * **路径化**的 `{ code, path, message }`（与 preview-schema.mjs 同一形状）。
 * 若将来改动其一的规则，必须同步另一处 —— 已在 tests/contract-schema.test.mjs 里
 * 用同一组样例锁住行为。
 *
 * 纪律：**只做"是否符合协议"的判定**，不推断、不放宽、不发明字段。
 */

export const CONTRACT_SCHEMA_VERSION = '1.0.0';

export const CONTRACT_LIMITS = Object.freeze({
  /** 契约是很小的元数据文件；给足余量但仍设上限，避免误喂大文件。 */
  maxBytes: 256 * 1024,
  maxStringCodePoints: 4096,
  maxTokenEntries: 512,
  maxRegions: 128,
  maxListEntries: 512,
  maxErrors: 50,
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function add(errors, code, path, message) {
  if (errors.length < CONTRACT_LIMITS.maxErrors) errors.push({ code, path, message });
  else errors.truncatedErrors = true;
}
function boundedString(value, path, errors, { nonempty = false } = {}) {
  if (typeof value !== 'string') {
    add(errors, 'type-mismatch', path, '必须是字符串');
    return false;
  }
  const length = Array.from(value).length;
  if ((nonempty && length === 0) || length > CONTRACT_LIMITS.maxStringCodePoints) {
    add(errors, 'invalid-value', path, `字符串长度必须为${nonempty ? '1' : '0'}–${CONTRACT_LIMITS.maxStringCodePoints}个 Unicode 码点`);
    return false;
  }
  return true;
}

/** 必填的顶层非空字符串字段（与 client.js 的 reqStr 列表一致）。 */
const REQUIRED_STRING_KEYS = ['schemaVersion', 'designId', 'designVersion', 'platform', 'screenId'];

/**
 * 校验一个已解析的 design-contract 对象。
 * @returns {{ ok: true, value: object } | { ok: false, errors: Array, truncatedErrors?: true }}
 */
export function validateContract(value) {
  const errors = [];

  if (!isObject(value)) {
    return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: 'contract 必须是 JSON 对象' }] };
  }

  for (const key of REQUIRED_STRING_KEYS) {
    if (!own(value, key)) add(errors, 'required-field', `$.${key}`, '缺少必填字段');
    else boundedString(value[key], `$.${key}`, errors, { nonempty: true });
  }

  if (own(value, 'description') && typeof value.description !== 'string') {
    add(errors, 'type-mismatch', '$.description', '若存在必须是字符串');
  } else if (own(value, 'description')) {
    boundedString(value.description, '$.description', errors, { nonempty: false });
  }

  if (!own(value, 'designTokens')) add(errors, 'required-field', '$.designTokens', '缺少必填字段');
  else if (!isObject(value.designTokens)) add(errors, 'type-mismatch', '$.designTokens', '必须是对象');
  else {
    const entries = Object.entries(value.designTokens);
    if (entries.length > CONTRACT_LIMITS.maxTokenEntries) {
      add(errors, 'limit-exceeded', '$.designTokens', `条目数超过 ${CONTRACT_LIMITS.maxTokenEntries}`);
    }
    for (const [key, item] of entries) {
      if (typeof item !== 'string' && typeof item !== 'number') {
        add(errors, 'type-mismatch', `$.designTokens.${key}`, '值必须是字符串或数字');
      } else if (typeof item === 'string') {
        boundedString(item, `$.designTokens.${key}`, errors, { nonempty: false });
      } else if (!Number.isFinite(item)) {
        add(errors, 'invalid-value', `$.designTokens.${key}`, '数值必须是有限数');
      }
    }
  }

  if (!own(value, 'layout')) add(errors, 'required-field', '$.layout', '缺少必填字段');
  else if (!isObject(value.layout)) add(errors, 'type-mismatch', '$.layout', '必须是对象');
  else {
    if (!own(value.layout, 'orientation')) add(errors, 'required-field', '$.layout.orientation', '缺少必填字段');
    else boundedString(value.layout.orientation, '$.layout.orientation', errors, { nonempty: true });

    if (!own(value.layout, 'regions')) add(errors, 'required-field', '$.layout.regions', '缺少必填字段');
    else if (!isStringArray(value.layout.regions)) add(errors, 'type-mismatch', '$.layout.regions', '必须是字符串数组');
    else if (value.layout.regions.length > CONTRACT_LIMITS.maxRegions) {
      add(errors, 'limit-exceeded', '$.layout.regions', `条目数超过 ${CONTRACT_LIMITS.maxRegions}`);
    }
  }

  if (!own(value, 'changeScope')) add(errors, 'required-field', '$.changeScope', '缺少必填字段');
  else if (!isObject(value.changeScope)) add(errors, 'type-mismatch', '$.changeScope', '必须是对象');
  else {
    for (const key of ['allowed', 'protected']) {
      if (!own(value.changeScope, key)) add(errors, 'required-field', `$.changeScope.${key}`, '缺少必填字段');
      else if (!isStringArray(value.changeScope[key])) add(errors, 'type-mismatch', `$.changeScope.${key}`, '必须是字符串数组');
      else if (value.changeScope[key].length > CONTRACT_LIMITS.maxListEntries) {
        add(errors, 'limit-exceeded', `$.changeScope.${key}`, `条目数超过 ${CONTRACT_LIMITS.maxListEntries}`);
      }
    }
  }

  if (!own(value, 'referenceAssets')) add(errors, 'required-field', '$.referenceAssets', '缺少必填字段');
  else if (!Array.isArray(value.referenceAssets)) add(errors, 'type-mismatch', '$.referenceAssets', '必须是数组');
  else if (value.referenceAssets.length > CONTRACT_LIMITS.maxListEntries) {
    add(errors, 'limit-exceeded', '$.referenceAssets', `条目数超过 ${CONTRACT_LIMITS.maxListEntries}`);
  }

  if (errors.truncatedErrors) return { ok: false, errors, truncatedErrors: true };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * 从 JSON 文本解析并校验契约。
 * 区分"解析失败"（`invalid-json`）与"协议校验失败"，与 client.js 的 parseContract 行为一致。
 */
export function parseContractText(text) {
  if (typeof text !== 'string') {
    return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: 'contract 输入必须是字符串' }] };
  }
  let byteLength;
  try {
    byteLength = new TextEncoder().encode(text).byteLength;
  } catch {
    return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: '无法计算 UTF-8 字节长度' }] };
  }
  if (byteLength > CONTRACT_LIMITS.maxBytes) {
    return { ok: false, errors: [{ code: 'input-too-large', path: '$', message: `UTF-8 字节数超过 ${CONTRACT_LIMITS.maxBytes}` }] };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ code: 'invalid-json', path: '$', message: 'JSON 语法无效' }] };
  }
  return validateContract(value);
}
