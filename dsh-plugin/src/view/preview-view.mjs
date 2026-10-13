const h = (React, type, props, ...children) => React.createElement(type, props, ...children);
const esc = value => String(value ?? '');

export function findPreviewNode(node, id) {
  if (!node || !id) return null;
  if (node.id === id) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findPreviewNode(child, id);
    if (found) return found;
  }
  return null;
}

export function PreviewCanvas({ React, page, selectedId, onSelect }) {
  const renderNode = (node, parentMode = 'flow') => {
    const absolute = node.layout?.mode === 'absolute';
    const layout = absolute ? {
      position: 'absolute', left: `${node.layout.x}px`, top: `${node.layout.y}px`,
      width: `${node.layout.width}px`, height: `${node.layout.height}px`, boxSizing: 'border-box',
    } : undefined;
    const frameAbs = node.type === 'frame' && node.props?.layoutMode === 'absolute';
    const selected = selectedId === node.id;
    const common = {
      key: node.id, className: `db-preview-node${selected ? ' is-selected' : ''}`,
      style: layout, 'data-node-id': node.id, 'data-node-type': node.type,
      onClick: event => { event.stopPropagation(); onSelect(node); },
      role: 'button', tabIndex: 0, 'aria-pressed': selected,
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); } },
    };
    const children = Array.isArray(node.children) ? node.children.map(child => renderNode(child, node.props?.layoutMode ?? 'flow')) : [];
    const childStyle = node.type === 'frame' ? {
      display: frameAbs ? 'block' : 'flex', flexDirection: node.props.direction === 'row' ? 'row' : 'column',
      gap: `${node.props.gap ?? 8}px`, padding: `${node.props.padding ?? 8}px`,
      position: frameAbs ? 'relative' : undefined, boxSizing: 'border-box', minWidth: 0,
    } : undefined;
    switch (node.type) {
      case 'frame': return h(React, 'div', { ...common, className: `${common.className} db-preview-frame`, style: { ...childStyle, ...layout } }, ...children);
      case 'card': return h(React, 'section', { ...common, className: `${common.className} db-preview-card` }, h(React, 'strong', null, esc(node.props.title)), node.props.subtitle ? h(React, 'small', null, esc(node.props.subtitle)) : null, ...children);
      case 'list': return h(React, 'div', { ...common, className: `${common.className} db-preview-list` }, ...children);
      case 'list-item': return h(React, 'div', { ...common, className: `${common.className} db-preview-listitem` }, h(React, 'span', null, esc(node.props.label)), node.props.meta ? h(React, 'small', null, esc(node.props.meta)) : null, node.props.trailing ? h(React, 'span', null, esc(node.props.trailing)) : null);
      case 'text': return h(React, 'div', { ...common, className: `${common.className} db-preview-text`, style: { fontSize: `${node.props.size ?? 14}px`, fontWeight: node.props.weight === 'bold' || node.props.weight === 'semibold' ? 650 : 400, ...layout } }, esc(node.props.text));
      case 'button': return h(React, 'div', { ...common, className: `${common.className} db-preview-button${node.props.disabled ? ' is-disabled' : ''}`, 'aria-disabled': Boolean(node.props.disabled) }, esc(node.props.label));
      case 'badge': return h(React, 'div', { ...common, className: `${common.className} db-preview-badge` }, esc(node.props.label));
      case 'divider': return h(React, 'div', { ...common, className: `${common.className} db-preview-divider`, 'aria-label': 'divider' });
      case 'image-placeholder': return h(React, 'div', { ...common, className: `${common.className} db-preview-image-placeholder` }, `▧ ${esc(node.props.label)}`);
      default: return null;
    }
  };
  return h(React, 'div', { className: 'db-preview-viewport' },
    h(React, 'div', { className: 'db-preview-page', style: { width: `${page.viewport.widthDp}px`, minHeight: `${page.viewport.heightDp}px` }, 'data-page-id': page.id },
      h(React, 'div', { className: 'db-preview-page-title' }, esc(page.title)), renderNode(page.root)));
}

export function SelectionPanel({ React, node }) {
  const h_ = (type, props, ...children) => React.createElement(type, props, ...children);
  if (!node) return h_('section', { className: 'db-preview-selection' }, h_('h3', null, '组件属性'), h_('p', null, '点击画布中的组件查看属性。'));
  return h_('section', { className: 'db-preview-selection', 'data-selection-id': node.id },
    h_('h3', null, '组件属性'),
    h_('dl', null,
      h_('dt', null, 'ID'), h_('dd', null, esc(node.id)),
      h_('dt', null, '类型'), h_('dd', null, esc(node.type)),
      h_('dt', null, '属性'), h_('dd', null, h_('pre', null, JSON.stringify(node.props, null, 2))),
      h_('dt', null, '布局'), h_('dd', null, h_('pre', null, JSON.stringify(node.layout ?? { mode: 'flow (default)' }, null, 2)))));
}
