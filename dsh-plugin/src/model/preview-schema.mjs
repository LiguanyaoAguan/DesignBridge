export const PREVIEW_SCHEMA_VERSION = '1.0.0';
export const LIMITS = Object.freeze({ maxBytes: 512 * 1024, maxPages: 32, maxNodesPerPage: 2000, maxDepth: 12, maxStringCodePoints: 4096, maxErrors: 50 });

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const COMPONENTS = Object.freeze({
  frame: { required: ['direction', 'layoutMode'], optional: ['gap', 'padding'], children: 'any' },
  text: { required: ['text'], optional: ['size', 'weight', 'tone'], children: 'none' },
  button: { required: ['label'], optional: ['variant', 'disabled'], children: 'none' },
  card: { required: ['title'], optional: ['subtitle', 'elevation'], children: 'any' },
  list: { required: [], optional: ['dense'], children: 'list-item' },
  'list-item': { required: ['label'], optional: ['subtitle', 'meta', 'trailing', 'asset', 'selected'], children: 'none' },
  badge: { required: ['label'], optional: ['tone'], children: 'none' },
  divider: { required: [], optional: [], children: 'none' },
  'image-placeholder': { required: ['label'], optional: [], children: 'none' },
  // ── v0.7 高保真组件（全部为**增量**：新字段一律可选，旧设计不提供也能渲染）──
  icon: { required: ['asset'], optional: ['size', 'tone', 'align', 'label'], children: 'none' },
  image: { required: ['asset'], optional: ['fit', 'alt'], children: 'none' },
  input: { required: ['placeholder'], optional: ['value', 'kind', 'state'], children: 'none' },
  chip: { required: ['label'], optional: ['state', 'tone'], children: 'none' },
});
export const COMPONENT_TYPES = Object.freeze(Object.keys(COMPONENTS));

function add(errors, code, path, message) {
  if (errors.length < LIMITS.maxErrors) errors.push({ code, path, message });
  else errors.truncatedErrors = true;
}
function stopIfAtCap(errors) { return Boolean(errors.truncatedErrors); }
function cappedResult(errors, value) {
  if (errors.length === 0) return { ok: true, value };
  // true means at least one error was actually omitted after reaching the cap.
  return { ok: false, errors, ...(errors.truncatedErrors ? { truncatedErrors: true } : {}) };
}
function parentLayoutMode(parent) {
  return parent?.type === 'frame' && isObject(parent.props) ? parent.props.layoutMode : undefined;
}
function exactKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) addIf(errors, !allowed.includes(key), 'unknown-field', `${path}.${key}`, `未知字段：${key}`);
}
function addIf(errors, condition, code, path, message) { if (condition) add(errors, code, path, message); }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function boundedString(value, path, errors, { nonempty = false, max = LIMITS.maxStringCodePoints } = {}) {
  if (typeof value !== 'string') { add(errors, 'type-mismatch', path, '必须是字符串'); return; }
  const length = Array.from(value).length;
  if ((nonempty && length === 0) || length > max) add(errors, 'invalid-value', path, `字符串长度必须为${nonempty ? '1' : '0'}–${max}个 Unicode 码点`);
}
function checkProps(type, props, path, errors) {
  if (!isObject(props)) { add(errors, 'type-mismatch', path, 'props 必须是对象'); return; }
  const spec = COMPONENTS[type];
  exactKeys(props, [...spec.required, ...spec.optional], path, errors);
  for (const key of spec.required) addIf(errors, !own(props, key), 'required-field', `${path}.${key}`, '缺少必填字段');
  const str = (key, nonempty = true) => { if (own(props, key)) boundedString(props[key], `${path}.${key}`, errors, { nonempty }); };
  const num = (key, min, max) => {
    if (own(props, key) && (!finite(props[key]) || props[key] < min || props[key] > max)) add(errors, 'invalid-value', `${path}.${key}`, `必须是 ${min}–${max} 范围内的有限数`);
  };
  const en = (key, values) => { if (own(props, key) && !values.includes(props[key])) add(errors, 'invalid-value', `${path}.${key}`, `允许值：${values.join(', ')}`); };
  const bool = key => { if (own(props, key) && typeof props[key] !== 'boolean') add(errors, 'type-mismatch', `${path}.${key}`, '必须是布尔值'); };
  switch (type) {
    case 'frame': en('direction', ['row', 'column']); en('layoutMode', ['flow', 'absolute']); num('gap', 0, 512); num('padding', 0, 512); break;
    case 'text': str('text'); num('size', 1, 256); en('weight', ['normal', 'medium', 'semibold', 'bold']); en('tone', ['primary', 'secondary', 'tertiary']); break;
    case 'button': str('label'); en('variant', ['primary', 'secondary', 'ghost']); bool('disabled'); break;
    case 'card': str('title'); str('subtitle', false); en('elevation', ['none', 'sm', 'md']); break;
    case 'list': bool('dense'); break;
    case 'list-item': str('label'); str('subtitle', false); str('meta', false); str('trailing', false); str('asset', false); bool('selected'); break;
    case 'badge': str('label'); en('tone', ['primary', 'secondary', 'tertiary', 'success', 'warning', 'danger']); break;
    case 'image-placeholder': str('label'); break;
    case 'icon': str('asset'); num('size', 8, 128); en('tone', ['primary', 'secondary', 'tertiary', 'accent']); en('align', ['start', 'center', 'end']); str('label', false); break;
    case 'image': str('asset'); en('fit', ['cover', 'contain']); str('alt', false); break;
    case 'input': str('placeholder'); str('value', false); en('kind', ['search', 'text']); en('state', ['normal', 'focused', 'disabled']); break;
    case 'chip': str('label'); en('state', ['normal', 'selected', 'disabled']); en('tone', ['primary', 'secondary']); break;
  }
}
function checkLayout(layout, path, parent, errors) {
  if (layout === undefined) {
    addIf(errors, parentLayoutMode(parent) === 'absolute', 'layout-mode-conflict', path, 'absolute frame 的直接子节点必须声明 absolute layout');
    return;
  }
  if (!isObject(layout)) { add(errors, 'type-mismatch', path, 'layout 必须是对象'); return; }
  const mode = layout.mode;
  if (mode === 'flow') {
    exactKeys(layout, ['mode'], path, errors);
    addIf(errors, parentLayoutMode(parent) === 'absolute', 'layout-mode-conflict', `${path}.mode`, 'absolute frame 的直接子节点不能使用 flow');
    return;
  }
  if (mode !== 'absolute') { add(errors, 'invalid-value', `${path}.mode`, 'mode 必须为 flow 或 absolute'); return; }
  exactKeys(layout, ['mode', 'x', 'y', 'width', 'height'], path, errors);
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!own(layout, key)) add(errors, 'required-field', `${path}.${key}`, 'absolute layout 缺少坐标/尺寸');
    else if (!finite(layout[key]) || (key === 'width' || key === 'height' ? layout[key] <= 0 || layout[key] > 4096 : Math.abs(layout[key]) > 4096)) add(errors, 'invalid-value', `${path}.${key}`, '必须是有效 dp 数值；宽高须 >0 且 ≤4096');
  }
  addIf(errors, parent?.type !== 'frame' || parentLayoutMode(parent) !== 'absolute', 'layout-mode-conflict', path, 'absolute layout 仅允许作为 absolute frame 的直接子节点');
}
function walkNode(node, path, depth, context, errors) {
  if (stopIfAtCap(errors)) return;
  if (!isObject(node)) { add(errors, 'type-mismatch', path, '组件节点必须是对象'); return; }
  exactKeys(node, ['id', 'type', 'props', 'layout', 'children'], path, errors);
  if (typeof node.id !== 'string' || !ID_RE.test(node.id)) add(errors, 'invalid-value', `${path}.id`, 'ID 格式非法');
  else if (context.ids.has(node.id)) add(errors, 'duplicate-node-id', `${path}.id`, `组件 ID 重复：${node.id}`);
  else context.ids.add(node.id);
  if (typeof node.type !== 'string' || !own(COMPONENTS, node.type)) { add(errors, 'unknown-component-type', `${path}.type`, '未知组件类型'); return; }
  if (depth > LIMITS.maxDepth) { add(errors, 'limit-exceeded', path, `树深度超过 ${LIMITS.maxDepth}`); return; }
  context.count += 1;
  if (context.count > LIMITS.maxNodesPerPage) { add(errors, 'limit-exceeded', path, `每页节点数超过 ${LIMITS.maxNodesPerPage}`); return; }
  if (depth === 1 && node.type !== 'frame') add(errors, 'invalid-nesting', `${path}.type`, '页面 root 必须是 frame');
  checkProps(node.type, node.props, `${path}.props`, errors);
  checkLayout(node.layout, `${path}.layout`, context.parent, errors);
  const spec = COMPONENTS[node.type];
  if (spec.children === 'none' && own(node, 'children')) add(errors, 'invalid-nesting', `${path}.children`, '叶节点禁止 children');
  if (node.type === 'list' && !own(node, 'children')) add(errors, 'required-field', `${path}.children`, 'list 必须至少包含一个 list-item');
  if (spec.children !== 'none' && own(node, 'children')) {
    if (!Array.isArray(node.children)) { add(errors, 'type-mismatch', `${path}.children`, 'children 必须是数组'); return; }
    if (node.type === 'list' && node.children.length === 0) add(errors, 'invalid-nesting', `${path}.children`, 'list 必须至少包含一个 list-item');
    node.children.forEach((child, index) => {
      if (stopIfAtCap(errors)) return;
      if (node.type === 'list' && (!isObject(child) || child.type !== 'list-item')) add(errors, 'invalid-nesting', `${path}.children[${index}].type`, 'list 只允许直接包含 list-item');
      walkNode(child, `${path}.children[${index}]`, depth + 1, { ids: context.ids, get count() { return context.count; }, set count(v) { context.count = v; }, parent: node }, errors);
    });
  }
}

export function validatePreviewSchema(value) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: 'preview 必须是对象' }] };
  exactKeys(value, ['previewSchemaVersion', 'designId', 'designVersion', 'pages'], '$', errors);
  if (!own(value, 'previewSchemaVersion')) add(errors, 'required-field', '$.previewSchemaVersion', '缺少必填字段');
  else if (value.previewSchemaVersion !== PREVIEW_SCHEMA_VERSION) add(errors, 'unsupported-version', '$.previewSchemaVersion', '不支持的 Preview Schema 版本');
  for (const key of ['designId', 'designVersion']) {
    if (!own(value, key)) add(errors, 'required-field', `$.${key}`, '缺少必填字段');
    else boundedString(value[key], `$.${key}`, errors, { nonempty: true, max: 128 });
  }
  if (stopIfAtCap(errors)) return cappedResult(errors, value);
  if (!Array.isArray(value.pages)) add(errors, 'type-mismatch', '$.pages', 'pages 必须是数组');
  else {
    if (value.pages.length < 1 || value.pages.length > LIMITS.maxPages) add(errors, 'limit-exceeded', '$.pages', `pages 数量必须为 1–${LIMITS.maxPages}`);
    const pageIds = new Set();
    value.pages.forEach((page, index) => {
      if (stopIfAtCap(errors)) return;
      const path = `$.pages[${index}]`;
      if (!isObject(page)) { add(errors, 'type-mismatch', path, 'page 必须是对象'); return; }
      exactKeys(page, ['id', 'title', 'viewport', 'root'], path, errors);
      if (typeof page.id !== 'string' || !ID_RE.test(page.id)) add(errors, 'invalid-value', `${path}.id`, '页面 ID 格式非法');
      else if (pageIds.has(page.id)) add(errors, 'duplicate-page-id', `${path}.id`, `页面 ID 重复：${page.id}`);
      else pageIds.add(page.id);
      if (!own(page, 'title')) add(errors, 'required-field', `${path}.title`, '缺少必填字段'); else boundedString(page.title, `${path}.title`, errors, { nonempty: true, max: 120 });
      if (!isObject(page.viewport)) add(errors, 'type-mismatch', `${path}.viewport`, 'viewport 必须是对象');
      else {
        exactKeys(page.viewport, ['widthDp', 'heightDp', 'orientation'], `${path}.viewport`, errors);
        for (const key of ['widthDp', 'heightDp']) {
          if (!own(page.viewport, key)) add(errors, 'required-field', `${path}.viewport.${key}`, '缺少必填字段');
          else if (!finite(page.viewport[key]) || page.viewport[key] <= 0 || page.viewport[key] > 4096) add(errors, 'invalid-value', `${path}.viewport.${key}`, '必须为 >0 且 ≤4096 的有限 dp 数值');
        }
        if (!['portrait', 'landscape'].includes(page.viewport.orientation)) add(errors, 'invalid-value', `${path}.viewport.orientation`, '允许值：portrait, landscape');
      }
      if (!own(page, 'root')) add(errors, 'required-field', `${path}.root`, '缺少必填字段');
      else walkNode(page.root, `${path}.root`, 1, { ids: new Set(), count: 0, parent: null }, errors);
    });
  }
  return cappedResult(errors, value);
}
