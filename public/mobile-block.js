(() => {
  const ua = navigator.userAgent || '';
  const phoneByUa = /iPhone|iPod|Windows Phone|IEMobile|Opera Mini|Android.*Mobile/i.test(ua);
  const compactTouch = window.matchMedia?.('(pointer: coarse) and (max-width: 900px)').matches;
  if (!phoneByUa && !compactTouch) return;

  document.documentElement.classList.add('mobile-blocked');

  async function renderMobileBlock() {
    const block = document.createElement('main');
    block.id = 'mobileBlock';
    block.className = 'mobile-block';
    block.setAttribute('role', 'main');

    const message = document.createElement('div');
    message.className = 'mobile-block-message';
    message.textContent = 'Photo Sorter удобнее открыть с компьютера.';

    const wink = document.createElement('div');
    wink.className = 'mobile-block-wink';
    wink.textContent = '😉';
    wink.setAttribute('aria-hidden', 'true');

    block.append(message, wink);
    document.body.prepend(block);

    try {
      const res = await fetch('/mobile-message.txt', { cache: 'no-store' });
      if (!res.ok) return;
      const text = (await res.text()).trim();
      if (text) message.textContent = text;
    } catch (_) {
      // Оставляем встроенный fallback-текст.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderMobileBlock, { once: true });
  } else {
    renderMobileBlock();
  }
})();
