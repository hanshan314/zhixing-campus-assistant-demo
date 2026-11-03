window.__ModuleLoader__.load({
  id: '@local/dsh-class-picker',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Picker() {
      const [open, setOpen] = React.useState(false);
      const button = React.useRef(null);
      React.useEffect(() => {
        if (!open) return;
        const handler = e => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
      }, [open]);
      const connection = window.__DSH_CLASS_PICKER__;
      return h(React.Fragment, null,
        h('button', { ref: button, type: 'button', title: '打开账号与抽签工作台', onClick: () => setOpen(true), style: { position: 'fixed', right: '24px', bottom: '76px', zIndex: 200, border: '1px solid #ded5ec', borderRadius: '16px', padding: '12px 18px', background: '#6950a1', color: 'white', font: '600 14px system-ui', cursor: 'pointer', boxShadow: '0 5px 22px #0002' } }, '⇄  抽签工作台'),
        open && h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': '班级活动选人', style: { position: 'fixed', inset: 0, zIndex: 10000, background: '#20202b88', display: 'flex', flexDirection: 'column', padding: '20px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', padding: '10px 18px', borderRadius: '16px 16px 0 0', color: '#282433', font: '14px system-ui' } },
            h('span', null, '轮到你啦 · 账号与抽签'),
            h('button', { type: 'button', autoFocus: true, onClick: () => { setOpen(false); button.current?.focus(); }, style: { border: 0, background: '#f0edf5', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', color: '#30293d' } }, '关闭 ×')),
          connection ? h('iframe', { title: '班级选人工作台', src: connection.path + '#access=' + encodeURIComponent(connection.token), style: { flex: 1, width: '100%', border: 0, borderRadius: '0 0 16px 16px', background: '#f7f7f9' } }) : h('p', { style: { background: 'white', padding: 30 } }, '插件服务尚未连接。请重启 Harness 并刷新页面。')));
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'class-picker', order: 45 }, () => h(Picker)));
    } };
  }
});
