import { LIMITS, validatePreviewSchema } from './preview-schema.mjs';

function error(code, path, message) { return { code, path, message }; }

export function parsePreviewText(text, contract) {
  if (typeof text !== 'string') return { ok: false, errors: [error('type-mismatch', '$', 'preview 输入必须是字符串')] };
  let byteLength;
  try { byteLength = new TextEncoder().encode(text).byteLength; }
  catch { return { ok: false, errors: [error('type-mismatch', '$', '无法计算 UTF-8 字节长度')] };
  }
  if (byteLength > LIMITS.maxBytes) return { ok: false, errors: [error('input-too-large', '$', `UTF-8 字节数超过 ${LIMITS.maxBytes}`)] };

  let value;
  try { value = JSON.parse(text); }
  catch { return { ok: false, errors: [error('invalid-json', '$', 'JSON 语法无效')] }; }
  const schema = validatePreviewSchema(value);
  if (!schema.ok) return schema;

  const errors = [];
  const add = (code, path, message) => {
    if (errors.length < LIMITS.maxErrors) errors.push(error(code, path, message));
    else errors.truncatedErrors = true;
  };
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return { ok: false, errors: [error('contract-invalid', '$contract', 'design contract 缺失或无效')] };
  if (value.designId !== contract.designId) add('design-id-mismatch', '$.designId', 'designId 与 contract 不一致');
  if (value.designVersion !== contract.designVersion) add('design-version-mismatch', '$.designVersion', 'designVersion 与 contract 不一致');

  // Only inspect contract fields that actually exist. The schema does not infer dimensions.
  if (Object.prototype.hasOwnProperty.call(contract, 'screenId') && !value.pages.some(page => page.id === contract.screenId)) {
    add('screen-id-mismatch', '$.pages', 'pages 未包含 contract.screenId 对应页面');
  }
  if (errors.truncatedErrors) return { ok: false, errors, truncatedErrors: true };
  const orientation = contract.layout && typeof contract.layout === 'object' && !Array.isArray(contract.layout)
    ? contract.layout.orientation
    : undefined;
  if (orientation !== undefined) {
    for (let i = 0; i < value.pages.length && !errors.truncatedErrors; i += 1) {
      if (value.pages[i].viewport.orientation !== orientation) add('orientation-mismatch', `$.pages[${i}].viewport.orientation`, 'viewport.orientation 与 contract.layout.orientation 不一致');
    }
  }
  return errors.length ? { ok: false, errors, ...(errors.truncatedErrors ? { truncatedErrors: true } : {}) } : { ok: true, value };
}
