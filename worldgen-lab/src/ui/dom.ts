/** Tiny DOM helpers. */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string; attrs?: Record<string, string>; style?: string; on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.style) el.setAttribute('style', props.style);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (props.on) for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
  for (const c of children) if (c) el.append(c);
  return el;
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { attrs: { href: url, download: name } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export class Toasts {
  readonly root = h('div', { class: 'toasts' });

  show(message: string, kind: 'info' | 'error' = 'info', ms = 2600): void {
    const t = h('div', { class: `toast glass ${kind === 'error' ? 'error' : ''}`, text: message });
    this.root.append(t);
    setTimeout(() => t.remove(), ms);
  }
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export const LOGO_SVG =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 26 L11 12 L16 19 L21 9 L30 26 Z" fill="#7cc4ff"/><path d="M11 12 L13.6 16 L11.6 17.4 L9.4 14.6 Z" fill="#e7f4ff"/><path d="M21 9 L24.2 14.8 L21.6 16.6 L19 13 Z" fill="#e7f4ff"/><circle cx="25" cy="6.5" r="2.6" fill="#ffd479"/></svg>';
