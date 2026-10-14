/* Enterprise Knowledge course reader. Buildless; no external services. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { data: null, slides: [], byNumber: new Map(), modules: [], current: null, query: '', tokens: [], focusAfterNavigate: false, toastTimer: 0 };
  const elements = {
    reader: $('reader'), loading: $('loading-panel'), error: $('error-panel'), nav: $('course-nav'),
    search: $('search-input'), sidebar: $('sidebar'), backdrop: $('nav-backdrop'), menu: $('menu-toggle'),
    image: $('slide-image'), dialog: $('image-dialog'), transcript: $('transcript'),
  };

  const textOf = (value) => value == null ? '' : String(value);
  const normalized = (value) => textOf(value).normalize('NFKC').toLocaleLowerCase('ko');
  const isTyping = (target) => target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3200);
  }

  function safeLink(value) {
    try {
      const url = new URL(textOf(value), window.location.href);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function safeImage(value) {
    const path = textOf(value).replace(/\\/g, '/');
    if (!/^assets\/slides\/[a-zA-Z0-9_-]+\.(webp|png|jpe?g)$/i.test(path)) return null;
    return path;
  }

  function appendHighlighted(parent, value) {
    const text = textOf(value);
    if (!state.query || !state.tokens.length) { parent.append(document.createTextNode(text)); return; }
    // Highlight exact query tokens while retaining every original character.
    const lower = text.toLocaleLowerCase('ko');
    const ranges = [];
    for (const token of state.tokens) {
      let start = 0;
      while (token && (start = lower.indexOf(token, start)) !== -1) {
        ranges.push([start, start + token.length]); start += token.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range.slice());
    }
    let cursor = 0;
    for (const [start, end] of merged) {
      parent.append(document.createTextNode(text.slice(cursor, start)), node('mark', '', text.slice(start, end)));
      cursor = end;
    }
    parent.append(document.createTextNode(text.slice(cursor)));
  }

  function appendRichText(parent, value) {
    const text = textOf(value);
    const references = /\bp\.\s*(\d+)\b/gi;
    let cursor = 0;
    for (const match of text.matchAll(references)) {
      const number = Number(match[1]);
      if (!state.byNumber.has(number)) continue;
      appendHighlighted(parent, text.slice(cursor, match.index));
      const link = node('a', 'inline-reference');
      link.href = `#slide-${number}`;
      link.title = `원본 ${number}쪽: ${state.byNumber.get(number).title}`;
      link.addEventListener('click', () => { state.focusAfterNavigate = true; });
      appendHighlighted(link, match[0]);
      parent.append(link);
      cursor = match.index + match[0].length;
    }
    appendHighlighted(parent, text.slice(cursor));
  }

  function closeMenu(restoreFocus = false) {
    elements.sidebar.classList.remove('is-open');
    elements.backdrop.hidden = true;
    elements.menu.setAttribute('aria-expanded', 'false');
    elements.menu.setAttribute('aria-label', '교육 목차 열기');
    document.body.classList.remove('nav-open');
    elements.sidebar.inert = matchMedia('(max-width: 800px)').matches;
    if (restoreFocus) elements.menu.focus();
  }

  function openMenu() {
    elements.sidebar.inert = false;
    elements.sidebar.classList.add('is-open');
    elements.backdrop.hidden = false;
    elements.menu.setAttribute('aria-expanded', 'true');
    elements.menu.setAttribute('aria-label', '교육 목차 닫기');
    document.body.classList.add('nav-open');
    $('menu-close').focus();
  }

  function searchExcerpt(slide) {
    if (!state.query) return '';
    const pieces = [...slide.paragraphs, ...slide.tables.flat(2)];
    const match = pieces.find((piece) => state.tokens.some((token) => normalized(piece).includes(token)));
    if (!match) return '';
    const lower = normalized(match);
    const starts = state.tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
    const position = starts.length ? Math.min(...starts) : 0;
    const start = Math.max(0, position - 20);
    return `${start ? '…' : ''}${textOf(match).slice(start, start + 85)}${textOf(match).length > start + 85 ? '…' : ''}`;
  }

  function renderNavigation() {
    const previousOpen = new Set([...elements.nav.querySelectorAll('details[open]')].map((element) => element.dataset.module));
    elements.nav.replaceChildren();
    const matching = state.slides.filter((slide) => state.tokens.every((token) => slide.searchText.includes(token)));
    const matchingNumbers = new Set(matching.map((slide) => slide.number));
    $('search-status').textContent = state.query
      ? `검색 결과 ${matching.length}개 / 전체 ${state.slides.length}개`
      : `공개 ${state.slides.length}개 · 원본 ${state.data.sourceSlideCount || state.slides.length}쪽 기준`;
    $('search-results-button').hidden = !state.query;
    $('search-results-button').textContent = `결과 ${matching.length}개`;

    if (!matching.length) {
      const empty = node('p', 'no-results', '일치하는 내용이 없습니다. 짧은 단어나 다른 표현으로 다시 검색해 보세요.');
      elements.nav.append(empty);
      return;
    }

    state.modules.forEach((module, moduleIndex) => {
      const slides = state.slides.filter((slide) => slide.module === module.id && matchingNumbers.has(slide.number));
      if (!slides.length) return;
      const details = node('details', 'module-group');
      details.dataset.module = module.id;
      details.open = Boolean(state.query) || state.current?.module === module.id || previousOpen.has(module.id);
      const summary = node('summary');
      summary.append(node('span', 'module-number', String(moduleIndex + 1).padStart(2, '0')), node('span', '', module.title), node('span', 'module-count', String(slides.length)));
      const list = node('ul', 'module-links');
      for (const slide of slides) {
        const item = node('li');
        const link = node('a', 'nav-link');
        link.href = `#slide-${slide.number}`;
        link.dataset.slide = String(slide.number);
        if (state.current?.number === slide.number) link.setAttribute('aria-current', 'page');
        link.append(node('span', 'nav-page', String(slide.number).padStart(2, '0')));
        const title = node('span', 'nav-title');
        appendHighlighted(title, slide.title);
        const excerpt = searchExcerpt(slide);
        if (excerpt) { const element = node('span', 'nav-excerpt'); appendHighlighted(element, excerpt); title.append(element); }
        link.append(title);
        link.addEventListener('click', (event) => {
          state.focusAfterNavigate = true;
          closeMenu();
          if (state.current?.number === slide.number) {
            event.preventDefault();
            if (state.query) { elements.transcript.open = true; renderTranscript(); }
            $('main').focus({ preventScroll: true });
            window.scrollTo({ top: 0, behavior: 'auto' });
            state.focusAfterNavigate = false;
          }
        });
        item.append(link); list.append(item);
      }
      details.append(summary, list); elements.nav.append(details);
    });
  }

  function renderTranscript() {
    const slide = state.current;
    if (!slide) return;
    const textContainer = $('slide-text');
    const tableContainer = $('slide-tables');
    const linkContainer = $('slide-links');
    textContainer.replaceChildren(); tableContainer.replaceChildren(); linkContainer.replaceChildren();
    for (const paragraph of slide.paragraphs) {
      if (!textOf(paragraph).trim()) continue;
      const element = node('p'); appendRichText(element, paragraph); textContainer.append(element);
    }
    if (!textContainer.childElementCount && !slide.tables.length) textContainer.append(node('p', '', '이 페이지는 이미지 중심으로 구성되어 있습니다. 위의 슬라이드에서 내용을 확인해 주세요.'));

    slide.tables.forEach((rows, tableIndex) => {
      if (!Array.isArray(rows) || !rows.length) return;
      const wrapper = node('div', 'table-wrapper');
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', `원본 ${slide.number}쪽 표 ${tableIndex + 1}`);
      const table = node('table');
      table.append(node('caption', '', `표 ${tableIndex + 1}`));
      const body = node('tbody');
      const merges = new Map((slide.tableMerges?.[tableIndex] || []).map((cell) => [`${cell.row}:${cell.column}`, cell]));
      rows.forEach((row, rowIndex) => {
        const tr = node('tr');
        row.forEach((cell, columnIndex) => {
          const merge = merges.get(`${rowIndex}:${columnIndex}`);
          if (merge?.skip) return;
          const td = node('td');
          if (Number.isInteger(merge?.rowspan) && merge.rowspan > 1) td.rowSpan = merge.rowspan;
          if (Number.isInteger(merge?.colspan) && merge.colspan > 1) td.colSpan = merge.colspan;
          appendRichText(td, cell); tr.append(td);
        });
        body.append(tr);
      });
      table.append(body); wrapper.append(table); tableContainer.append(wrapper);
    });

    const links = slide.links.map((link) => ({ label: textOf(link.label), url: safeLink(link.url) })).filter((link) => link.url);
    if (links.length) {
      linkContainer.append(node('h2', '', '슬라이드의 참고 링크'));
      const list = node('ul');
      links.forEach((link) => {
        const item = node('li'); const anchor = node('a', '', link.label || link.url);
        anchor.href = link.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        anchor.append(node('span', 'sr-only', ' (새 창)')); item.append(anchor); list.append(item);
      });
      linkContainer.append(list);
    }
  }

  function renderSlide(slide) {
    state.current = slide;
    const index = state.slides.indexOf(slide);
    const module = state.modules.find((item) => item.id === slide.module);
    $('slide-title').textContent = slide.title;
    $('source-page').textContent = `P. ${String(slide.number).padStart(2, '0')}`;
    $('module-label').textContent = module?.title || '교육 자료';
    $('position-label').textContent = `공개 슬라이드 ${index + 1} / ${state.slides.length} · 원본 ${slide.number}쪽`;
    $('navigation-count').replaceChildren(node('strong', '', String(index + 1).padStart(2, '0')), document.createTextNode(` / ${state.slides.length}`));
    $('previous-slide').disabled = index === 0;
    $('next-slide').disabled = index === state.slides.length - 1;
    $('previous-slide').title = index ? state.slides[index - 1].title : '첫 번째 슬라이드입니다';
    $('next-slide').title = index < state.slides.length - 1 ? state.slides[index + 1].title : '마지막 슬라이드입니다';
    $('public-mask-note').textContent = slide.publicMaskNote || '공개용으로 일부 정보가 가려져 있습니다.';
    $('public-mask-note').hidden = slide.publicMaskApplied !== true;
    const imagePath = safeImage(slide.image);
    elements.image.hidden = false;
    $('image-error').hidden = true;
    $('expand-slide').disabled = false;
    elements.image.alt = `원본 ${slide.number}쪽: ${slide.title}`;
    elements.image.setAttribute('aria-label', `원본 ${slide.number}쪽: ${slide.title}. 크게 보기`);
    elements.image.src = imagePath || '';
    if (!imagePath) handleImageError();
    document.title = `${slide.title} · Enterprise Knowledge Day 2`;
    if (state.query) elements.transcript.open = true;
    renderTranscript(); renderNavigation();
    if (!state.query) requestAnimationFrame(() => {
      const currentLink = elements.nav.querySelector('[aria-current="page"]');
      if (!currentLink) return;
      const linkRect = currentLink.getBoundingClientRect(), sidebarRect = elements.sidebar.getBoundingClientRect();
      if (linkRect.top < sidebarRect.top + 65 || linkRect.bottom > sidebarRect.bottom - 30) elements.sidebar.scrollTop += linkRect.top - sidebarRect.top - elements.sidebar.clientHeight * 0.4;
    });
    elements.reader.hidden = false;
    elements.loading.hidden = true;
    elements.error.hidden = true;
    if (state.focusAfterNavigate) { $('main').focus({ preventScroll: true }); state.focusAfterNavigate = false; }
  }

  function renderFromHash() {
    if (!state.slides.length) return;
    const match = /^#slide-(\d+)$/.exec(window.location.hash);
    const number = match ? Number(match[1]) : null;
    const slide = state.byNumber.get(number) || state.slides[0];
    if (window.location.hash && !state.byNumber.has(number)) {
      const hidden = state.data.hiddenSlides?.includes(number);
      showToast(hidden ? `원본 ${number}쪽은 공개 자료에 포함되지 않습니다. 첫 페이지를 표시합니다.` : '해당 페이지를 찾을 수 없어 첫 페이지를 표시합니다.');
      history.replaceState(null, '', `#slide-${slide.number}`);
    } else if (!window.location.hash) history.replaceState(null, '', `#slide-${slide.number}`);
    renderSlide(slide);
    closeMenu();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function navigate(offset) {
    const index = state.slides.indexOf(state.current) + offset;
    if (index < 0 || index >= state.slides.length) return;
    window.location.hash = `slide-${state.slides[index].number}`;
  }

  function handleImageError() {
    elements.image.hidden = true;
    $('image-error').hidden = false;
    $('expand-slide').disabled = true;
  }

  function expandImage() {
    if (!state.current || elements.image.hidden || !safeImage(state.current.image)) return;
    $('dialog-title').textContent = `원본 ${state.current.number}쪽 · ${state.current.title}`;
    $('dialog-image').src = state.current.image;
    $('dialog-image').alt = elements.image.alt;
    if (typeof elements.dialog.showModal === 'function') {
      elements.dialog.showModal();
      $('close-dialog').focus();
    } else window.open(state.current.image, '_blank', 'noopener,noreferrer');
  }

  function validateData(data) {
    if (!data || !Array.isArray(data.slides) || !data.slides.length || !Array.isArray(data.modules)) throw new Error('Invalid document data');
    const seen = new Set();
    const modules = data.modules.map((module) => ({ id: textOf(module.id), title: textOf(module.title) || '교육 자료' }));
    const hidden = new Set(data.hiddenSlides || []);
    const slides = data.slides.filter((slide) => !hidden.has(slide.number)).map((slide) => {
      if (!Number.isInteger(slide.number) || slide.number < 1 || seen.has(slide.number)) throw new Error('Invalid slide number');
      seen.add(slide.number);
      const paragraphs = Array.isArray(slide.paragraphs) ? slide.paragraphs.map(textOf) : [];
      const tables = Array.isArray(slide.tables) ? slide.tables.filter(Array.isArray).map((table) => table.filter(Array.isArray).map((row) => row.map(textOf))) : [];
      const title = textOf(slide.title).trim() || `원본 ${slide.number}쪽`;
      const module = textOf(slide.module);
      if (!modules.some((item) => item.id === module)) modules.push({ id: module, title: '기타 교육 자료' });
      return { ...slide, title, module, paragraphs, tables, links: Array.isArray(slide.links) ? slide.links : [], searchText: normalized([title, ...paragraphs, ...tables.flat(2)].join('\n')) };
    });
    if (!slides.length) throw new Error('No public slides');
    return { slides, modules };
  }

  async function loadDocument() {
    elements.loading.hidden = false; elements.error.hidden = true; elements.reader.hidden = true;
    try {
      if (location.protocol === 'file:') throw new Error('Local file protocol');
      const response = await fetch('./slides.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const validated = validateData(data);
      state.data = data; state.slides = validated.slides; state.modules = validated.modules;
      state.byNumber = new Map(state.slides.map((slide) => [slide.number, slide]));
      $('document-version').textContent = `${data.version || 'Day 2'} · 공개 ${state.slides.length}개`;
      $('document-updated').textContent = data.updated ? `자료 기준 ${textOf(data.updated)}` : '';
      elements.transcript.open = matchMedia('(max-width: 800px)').matches;
      renderFromHash();
    } catch {
      elements.loading.hidden = true; elements.error.hidden = false;
      $('search-status').textContent = '교육 자료를 불러오지 못했습니다.';
      $('error-message').textContent = location.protocol === 'file:'
        ? '이 HTML 파일은 slides.json을 함께 읽어야 합니다. 게시된 GitHub Pages 주소로 접속해 주세요. PC에서 확인하려면 전체 폴더를 로컬 웹 서버로 열어야 합니다.'
        : '교육 자료 파일(slides.json)을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요. 계속되면 교육 담당자에게 현재 페이지 주소를 알려 주세요.';
    }
  }

  elements.search.addEventListener('input', () => {
    state.query = elements.search.value.trim();
    state.tokens = normalized(state.query).split(/\s+/).filter(Boolean);
    if (!state.data) return;
    renderNavigation(); renderTranscript();
  });
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const first = elements.nav.querySelector('.nav-link');
    if (first) { state.focusAfterNavigate = true; first.click(); }
  });
  elements.menu.addEventListener('click', () => elements.sidebar.classList.contains('is-open') ? closeMenu(true) : openMenu());
  $('search-results-button').addEventListener('click', openMenu);
  $('menu-close').addEventListener('click', () => closeMenu(true));
  elements.backdrop.addEventListener('click', () => closeMenu(true));
  $('previous-slide').addEventListener('click', () => navigate(-1));
  $('next-slide').addEventListener('click', () => navigate(1));
  $('expand-slide').addEventListener('click', expandImage);
  elements.image.addEventListener('click', expandImage);
  elements.image.addEventListener('error', handleImageError);
  elements.image.setAttribute('role', 'button'); elements.image.tabIndex = 0;
  elements.image.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); expandImage(); } });
  $('close-dialog').addEventListener('click', () => elements.dialog.close());
  elements.dialog.addEventListener('click', (event) => { if (event.target === elements.dialog) { const rect = elements.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) elements.dialog.close(); } });
  elements.transcript.addEventListener('toggle', () => { elements.transcript.querySelector('.details-label').textContent = elements.transcript.open ? '접기' : '펼치기'; });
  $('retry-button').addEventListener('click', loadDocument);
  $('copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); showToast('현재 슬라이드의 링크를 복사했습니다.'); }
    catch { showToast('브라우저 주소창의 주소를 복사해 공유해 주세요.'); }
  });
  window.addEventListener('hashchange', renderFromHash);
  window.addEventListener('resize', () => {
    if (innerWidth > 800) closeMenu();
    else elements.sidebar.inert = !elements.sidebar.classList.contains('is-open');
  });
  document.addEventListener('keydown', (event) => {
    if (elements.dialog.open) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); closeMenu(); elements.search.focus(); elements.search.select(); return; }
    if (event.key === 'Escape') { if (elements.sidebar.classList.contains('is-open')) closeMenu(true); else if (document.activeElement === elements.search && state.query) { elements.search.value = ''; elements.search.dispatchEvent(new Event('input')); } return; }
    if (event.key === 'Tab' && elements.sidebar.classList.contains('is-open') && matchMedia('(max-width: 800px)').matches) {
      const focusable = [...elements.sidebar.querySelectorAll('a[href],button:not(:disabled),summary,[tabindex="0"]')].filter((element) => element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (elements.sidebar.classList.contains('is-open') && matchMedia('(max-width: 800px)').matches) return;
    if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
  });
  closeMenu();
  loadDocument();
})();
