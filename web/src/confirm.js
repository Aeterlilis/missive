// confirm.js —— 应用内的确认浮层，替代浏览器原生 confirm()。
// 原生弹窗走的是各平台自己的控件样式（安卓上是 Material 对话框），跟界面其余部分不是一套。
// 这里用跟卡片相同的玻璃材质重画一份，设置页和历史页共用。

let openDialog = null; // 同一时刻只允许存在一个浮层

/**
 * 弹出确认浮层。
 * @param {string} title 标题，通常是删除《某某》这类动作+对象。
 * @param {string} [body] 补充说明，可省略。
 * @param {{ confirmText?: string, cancelText?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>} 确认为 true，取消/关闭为 false。
 */
export function confirmDialog(title, body = '', opts = {}) {
  const { confirmText = '删除', cancelText = '取消', danger = true } = opts;

  // 前一个还开着就先收掉，避免叠层
  if (openDialog) openDialog.dismiss(false);

  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'confirm-scrim';

    const box = document.createElement('div');
    box.className = 'confirm-box';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');

    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.textContent = title;
    box.appendChild(titleEl);

    if (body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'confirm-body';
      bodyEl.textContent = body;
      box.appendChild(bodyEl);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'secondary' + (danger ? ' confirm-danger' : '');
    okBtn.textContent = confirmText;

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(actions);
    scrim.appendChild(box);

    // 关闭：先播退场动画，动画结束再摘掉节点
    let settled = false;
    const dismiss = (result) => {
      if (settled) return;
      settled = true;
      openDialog = null;
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.add('closing');
      const drop = () => scrim.remove();
      scrim.addEventListener('transitionend', drop, { once: true });
      setTimeout(drop, 260); // transitionend 没触发时的兜底
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); dismiss(true); }
    };

    cancelBtn.addEventListener('click', () => dismiss(false));
    okBtn.addEventListener('click', () => dismiss(true));
    // 点浮层外的遮罩算取消；点浮层本身不穿透
    scrim.addEventListener('click', (e) => { if (e.target === scrim) dismiss(false); });
    box.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(scrim);
    openDialog = { dismiss };
    // 入场动画写在 CSS 里（@keyframes），不走 requestAnimationFrame——
    // 页面不合成帧时 rAF 不会触发，那样浮层会停在全透明却仍然拦着点击。
    cancelBtn.focus();
  });
}
