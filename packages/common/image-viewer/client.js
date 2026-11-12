window.__ModuleLoader__.load({
  id: '@common/image-viewer',
  factory: require => {
    const React = require('react');
    const {Button, Modal, IconRefreshOutlineRegular, IconDownloadOutlineRegular,
      IconFullscreenOutlineRegular, IconCloseOutlineRegular, IconWarningOutlineRegular} = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const maxBytes = 20 * 1024 * 1024;
    // Controls and modal behavior belong to DSH; these styles only arrange the image surface.
    const css = `
      .civ{display:block;min-width:0;margin:8px 0;color:var(--dsw-alias-label-primary)}
      .civ-state{display:flex;align-items:center;gap:10px;min-height:64px;padding:12px 14px;
        border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
      .civ-state-icon{display:flex;flex:none;color:var(--dsw-alias-label-secondary)}
      .civ-state-copy{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
      .civ-state-title{font-size:14px;line-height:22px;font-weight:500}
      .civ-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
      .civ button.civ-thumbnail{display:block;width:fit-content;height:auto;max-width:100%;padding:0;cursor:zoom-in;overflow:hidden}
      .civ-thumbnail img{display:block;max-width:100%;max-height:600px;object-fit:contain;border-radius:var(--dsw-radius-md)}
      .civ-actions{display:flex;align-items:center;gap:8px;margin-top:6px;min-width:0;flex-wrap:wrap}
      .civ-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      div.civ-dialog{width:100%;height:100%;max-height:100%;gap:0;padding:0;color:var(--dsw-alias-label-primary)}
      .civ-header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
      .civ-title{flex:1;min-width:0}
      .civ-title-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px;font-weight:500}
      .civ-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .civ-viewport{position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;cursor:grab;background:var(--dsw-alias-bg-layer-1)}
      .civ-viewport:active{cursor:grabbing}
      .civ-original{position:absolute;left:50%;top:50%;max-width:none;user-select:none}
      .civ-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;flex-wrap:wrap;
        border-top:1px solid var(--dsw-alias-border-l2)}
      .civ-scale{min-width:48px;text-align:center;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
    `;

    function resolveImageSource(destination, cwd, origin = window.location.origin) {
      if (typeof destination !== 'string' || !destination.trim()) throw new Error('图片地址为空。');
      let path = destination.trim();
      const local = value => ({url: '/api/file?path=' + encodeURIComponent(value), local: true});
      const normalize = value => {
        const slash = value.replace(/\\/g, '/');
        const drive = /^[A-Za-z]:\//.test(slash) ? slash.slice(0, 3) : '/';
        const parts = [];
        for (const part of slash.slice(drive.length).split('/')) {
          if (!part || part === '.') continue;
          if (part === '..') parts.pop(); else parts.push(part);
        }
        return drive + parts.join('/');
      };
      if (/^(?:\\\\|\/\/)/.test(path)) throw new Error('暂不支持网络共享图片路径。');
      if (/^file:/i.test(path)) {
        let url;
        try { url = new URL(path); } catch { throw new Error('图片文件地址无效。'); }
        if (url.hostname && url.hostname !== 'localhost') throw new Error('暂不支持网络共享图片路径。');
        try { path = decodeURIComponent(url.pathname); } catch { throw new Error('图片地址编码无效。'); }
        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
        return local(normalize(path));
      }
      if (/^https?:/i.test(path) || path.startsWith('/api/file?')) {
        let url;
        try { url = new URL(path, origin); } catch { throw new Error('图片地址无效。'); }
        if (url.username || url.password) throw new Error('图片地址不能包含登录凭据。');
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        const nativeFile = url.pathname === '/api/file' && url.searchParams.has('path') &&
          [...url.searchParams.keys()].length === 1 && !url.hash;
        if (nativeFile && (url.origin === origin || loopback)) return local(url.searchParams.get('path'));
        return {url: url.href, local: false};
      }
      // Raw absolute file paths preserve literal percent signs. Only URI forms are decoded.
      if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return local(normalize(path));
      if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) throw new Error('不支持此图片地址类型。');
      if (!cwd || !(/^[A-Za-z]:[\\/]/.test(cwd) || /^\/(?!\/)/.test(cwd))) {
        throw new Error('缺少当前会话的工作目录，无法解析相对图片路径。');
      }
      // Relative Markdown destinations are URI paths; decode exactly once, never decoded absolute paths.
      try { path = decodeURIComponent(path); } catch { throw new Error('图片地址编码无效。'); }
      return local(normalize(cwd.replace(/[\\/]$/, '') + '/' + path));
    }

    async function readLocalImage(url, signal) {
      const response = await fetch(url, {signal, credentials: 'same-origin'});
      const rejectResponse = async message => { await response.body?.cancel(); throw new Error(message); };
      if (!response.ok) return rejectResponse(response.status === 404 ? '图片文件不存在或已移动。' :
        [401, 403].includes(response.status) ? '当前连接没有读取此图片的权限。' : '图片读取失败（HTTP ' + response.status + '）。');
      const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!type.startsWith('image/')) return rejectResponse('文件未返回可预览的图片类型。');
      if (Number(response.headers.get('content-length')) > maxBytes) return rejectResponse('图片超过 20 MB 预览限制。');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('图片超过 20 MB 预览限制。');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return new Blob(chunks, {type});
    }

    function ImageView({destination, cwd, alt = '图片', fileName, onIdentity}) {
      const identityCallback = React.useRef(onIdentity);
      identityCallback.current = onIdentity;
      const [attempt, retry] = React.useState(0);
      const [state, setState] = React.useState({});
      const [visible, setVisible] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [zoom, setZoom] = React.useState(1);
      const [pan, setPan] = React.useState({x: 0, y: 0});
      const [natural, setNatural] = React.useState({width: 0, height: 0});
      const container = React.useRef(null);
      const viewport = React.useRef(null);
      const drag = React.useRef(null);
      let source, resolveFailure;
      try { source = resolveImageSource(destination, cwd); } catch (error) { resolveFailure = error.message; }
      const url = source?.url;
      let downloadName = fileName;
      if (!downloadName && url) {
        const parsed = new URL(url, window.location.origin);
        const path = source.local ? parsed.searchParams.get('path') : parsed.pathname;
        downloadName = path?.split(/[\\/]/).pop();
        if (!source.local) { try { downloadName = decodeURIComponent(downloadName); } catch {} }
      }

      React.useEffect(() => {
        if (!window.IntersectionObserver) { setVisible(true); return; }
        const observer = new window.IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
        }, {rootMargin: '200px'});
        observer.observe(container.current);
        return () => observer.disconnect();
      }, []);
      React.useEffect(() => {
        if (!visible || !source) return;
        const controller = new AbortController();
        let objectUrl;
        setState({url});
        setOpen(false);
        if (!source.local) { setState({url, src: url}); return () => controller.abort(); }
        readLocalImage(url, controller.signal).then(blob => {
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setState({url, src: objectUrl});
          // Reuse the preview bytes; hashing must not delay display or trigger another fetch.
          if (identityCallback.current && window.crypto?.subtle) {
            blob.arrayBuffer().then(bytes => window.crypto.subtle.digest('SHA-256', bytes)).then(hash => {
              if (!controller.signal.aborted) identityCallback.current?.({path: imageKey(destination, cwd),
                hash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')});
            }).catch(() => {}); // Preview remains usable when content identity is unavailable.
          }
        }).catch(error => {
          if (!controller.signal.aborted) setState({url, error: error instanceof TypeError ? '无法连接图片服务，请检查连接后重试。' : error.message});
        });
        return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
      }, [url, visible, attempt]);
      const fit = () => {
        const rect = viewport.current?.getBoundingClientRect();
        setZoom(rect && natural.width && natural.height ? Math.min(1, rect.width / natural.width, rect.height / natural.height) : 1);
        setPan({x: 0, y: 0});
      };
      React.useEffect(() => {
        if (!open) return;
        fit();
        const surface = viewport.current;
        const wheel = event => {
          event.preventDefault();
          setZoom(value => Math.max(.05, Math.min(8, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15))));
        };
        surface?.addEventListener('wheel', wheel, {passive: false});
        const resize = () => fit();
        window.addEventListener('resize', resize);
        return () => { surface?.removeEventListener('wheel', wheel); window.removeEventListener('resize', resize); drag.current = null; };
      }, [open, natural.width, natural.height]);
      const error = resolveFailure || (state.url === url && state.error);
      const src = state.url === url ? state.src : null;
      const failDecode = () => setState({url, error: '图片无法解码或远程图片加载失败，请重试或下载查看。'});
      const icon = component => h(component, {size: 16});
      const download = variant => h(Button, {size: 'sm', variant, icon: icon(IconDownloadOutlineRegular), onClick: () => {
        const link = document.createElement('a');
        link.href = source?.local ? src || url : url;
        link.download = downloadName || 'image';
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        document.body.append(link); link.click(); link.remove();
      }}, '下载图片');
      const name = downloadName || alt;
      return h('span', {ref: container, className: 'civ'},
        error ? h('span', {role: 'alert', className: 'civ-state'},
          h('span', {className: 'civ-state-icon'}, icon(IconWarningOutlineRegular)),
          h('span', {className: 'civ-state-copy'}, h('span', {className: 'civ-state-title'}, '图片暂时无法预览'),
            h('span', {className: 'civ-meta'}, error)),
          h(Button, {size: 'sm', variant: 'outline', icon: icon(IconRefreshOutlineRegular),
            onClick: () => retry(value => value + 1)}, '重试')) :
        src ? h(Button, {className: 'civ-thumbnail', 'aria-label': '放大查看：' + alt, onClick: () => setOpen(true)},
          h('img', {src, alt, onError: failDecode,
            onLoad: event => setNatural({width: event.target.naturalWidth, height: event.target.naturalHeight})})) :
        h('span', {role: 'status', className: 'civ-state'}, h('span', {className: 'civ-meta'}, visible ? '正在加载图片…' : alt)),
        url ? h('span', {className: 'civ-actions'}, h('span', {className: 'civ-meta civ-name', title: name}, name),
          src && !error ? h(Button, {size: 'sm', icon: icon(IconFullscreenOutlineRegular), onClick: () => setOpen(true)}, '查看大图') : null,
          download('ghost')) : null,
        open && src && !error ? h(Modal, {open: true, headless: true, title: '图片预览：' + name, className: 'civ-dialog', onClose: () => setOpen(false)},
          h('div', {className: 'civ-header'},
            h('div', {className: 'civ-title'}, h('div', {className: 'civ-title-name', title: name}, name),
              h('div', {className: 'civ-meta'}, natural.width + ' × ' + natural.height)),
            h('div', {className: 'civ-toolbar'}, download('outline'),
              h(Button, {size: 'sm', icon: icon(IconCloseOutlineRegular), 'aria-label': '关闭图片预览',
                'data-modal-autofocus': true, onClick: () => setOpen(false)}, '关闭'))),
          h('div', {ref: viewport, className: 'civ-viewport',
            onPointerDown: event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = {x: event.clientX, y: event.clientY, pan, background: event.target === event.currentTarget}; },
            onPointerMove: event => { if (drag.current) setPan({x: drag.current.pan.x + event.clientX - drag.current.x, y: drag.current.pan.y + event.clientY - drag.current.y}); },
            onPointerUp: event => {
              const start = drag.current;
              if (start?.background && Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) < 4) setOpen(false);
              drag.current = null;
            }, onPointerCancel: () => { drag.current = null; }},
            h('img', {src, alt, draggable: false, className: 'civ-original', style: {width: natural.width, height: natural.height,
              transform: 'translate(-50%, -50%) translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')'}})),
          h('div', {className: 'civ-footer'},
            h('span', {className: 'civ-meta'}, '滚轮缩放 · 拖动平移 · Esc 关闭'),
            h('div', {className: 'civ-toolbar'},
              h(Button, {size: 'sm', variant: 'toolbar', icon: icon(IconFullscreenOutlineRegular), onClick: fit}, '适应窗口'),
              h(Button, {size: 'sm', variant: 'toolbar', onClick: () => { setZoom(1); setPan({x: 0, y: 0}); }}, '原始尺寸'),
              h('span', {className: 'civ-scale', 'aria-label': '当前缩放比例'}, Math.round(zoom * 100) + '%')))) : null);
    }
    // Native image and delivery slots share a stable Session/Turn identifier.
    // Only real rendered Markdown images register; code blocks and links never do.
    const inlineImages = new Map();
    function imageKey(destination, cwd) {
      try {
        const source = resolveImageSource(destination, cwd);
        if (!source.local) return source.url;
        const path = new URL(source.url, window.location.origin).searchParams.get('path');
        return /^[A-Za-z]:[\\/]/.test(path) ? path.toLowerCase() : path;
      } catch { return null; }
    }
    function imageRegistry(scope) {
      if (!scope) return null;
      let registry = inlineImages.get(scope);
      if (!registry) {
        const counts = new Map(), listeners = new Set(), deliveries = new Map();
        const notify = () => listeners.forEach(listener => listener());
        const release = () => Promise.resolve().then(() => {
          if (!counts.size && !deliveries.size && !listeners.size && inlineImages.get(scope) === registry) inlineImages.delete(scope);
        });
        registry = {
          addDelivery(token, path) {
            deliveries.set(token, {path, hash: null}); notify();
            return () => { deliveries.delete(token); notify(); release(); };
          },
          setDeliveryHash(token, hash) {
            const entry = deliveries.get(token);
            if (entry && entry.hash !== hash) { entry.hash = hash; notify(); }
          },
          isDuplicate(token) {
            const current = deliveries.get(token);
            if (!current) return false;
            for (const [other, entry] of deliveries) {
              if (other === token) return false;
              if ((current.path && current.path === entry.path) || (current.hash && current.hash === entry.hash)) return true;
            }
            return false;
          },
          has: key => counts.has(key),
          subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); release(); }; },
          add(key) {
            counts.set(key, (counts.get(key) || 0) + 1); notify();
            return () => {
              const count = counts.get(key) - 1;
              if (count) counts.set(key, count); else counts.delete(key);
              notify();
              release();
            };
          }
        };
        inlineImages.set(scope, registry);
      }
      return registry;
    }
    function InlineImage(props) {
      const registry = imageRegistry(props.imageScope), key = imageKey(props.destination, props.cwd);
      React.useEffect(() => registry && key ? registry.add(key) : undefined, [registry, key]);
      return h(ImageView, props);
    }
    function DeliveredImage(props) {
      const registry = imageRegistry(props.imageScope), key = imageKey(props.destination, props.cwd);
      const token = React.useRef({});
      const [identity, setIdentity] = React.useState(null);
      const [, update] = React.useState(0);
      React.useEffect(() => {
        if (!registry) return;
        const unsubscribe = registry.subscribe(() => update(value => value + 1));
        update(value => value + 1);
        return unsubscribe;
      }, [registry]);
      React.useEffect(() => registry?.addDelivery(token.current, key), [registry, key]);
      const hash = identity?.path === key ? identity.hash : null;
      React.useEffect(() => { registry?.setDeliveryHash(token.current, hash); }, [registry, key, hash]);
      if (registry?.has(key)) return props.duplicateView || null;
      return registry?.isDuplicate(token.current) ? props.duplicateView || null
        : h(ImageView, {...props, onIdentity: setIdentity});
    }
    function isImageDelivery(file) {
      return file.mediaType ? /^image\/(png|jpeg|webp|gif|bmp|avif)$/i.test(file.mediaType)
        : /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.path);
    }
    function DeliveryPreview({file, cwd, scope}) {
      return isImageDelivery(file)
        ? h('div', {'data-deliverable-preview': '', style: {minWidth: 0, marginBottom: 10}},
          h(DeliveredImage, {destination: file.path, cwd, imageScope: scope, alt: file.description || file.path, fileName: file.path.split(/[\\/]/).pop()}))
        : null;
    }
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        return () => style.remove();
      });
      ctx.slots.inject('conversation.chat.markdown.image', () => ctx.slots.register({
        name: 'conversation.chat.markdown.image', id: 'common-image-markdown-preview', priority: -100
      }, ({scope, ...props}) => h(InlineImage, {...props, imageScope: scope})));
      ctx.slots.inject('deliverables.file.preview', () => ctx.slots.register({
        name: 'deliverables.file.preview', id: 'common-image-delivery-preview'
      }, DeliveryPreview));
    }
    return {inject: ['slots'], apply, ImageView, InlineImage, DeliveredImage, DeliveryPreview, isImageDelivery, imageRegistry, imageKey, resolveImageSource, readLocalImage};
  }
});
