/**
 * How tall the page actually is, once the phone's keyboard is up.
 *
 * # Why `100%` and `100dvh` both fail
 *
 * This client is a fixed shell: a header, a scrolling body, a tab bar, and — on the terminal screen —
 * a row of control keys that has to sit directly above the keyboard, because Ctrl-C is most of what
 * anybody opens a terminal on a phone *for*.
 *
 * The **layout** viewport does not shrink when the virtual keyboard opens. On iOS the keyboard is
 * drawn over the page and the page is told nothing at all; on Android the behaviour depends on a
 * window flag the browser picks. So `height: 100%` keeps describing the whole screen, and the bottom
 * of the layout — the key bar, the send button, the tab bar — sits underneath the keyboard where it
 * cannot be tapped.
 *
 * `100dvh` does not fix this, and the name is why people think it does: the "dynamic" it tracks is
 * the *browser chrome* collapsing as you scroll, not the keyboard. It is the same number in both
 * states.
 *
 * The **visual** viewport is the one that shrinks, and `window.visualViewport` is the only API that
 * reports it. So its height goes into `--cf-vh`, which `mobile.css` uses in place of `height: 100%`,
 * and its `offsetTop` goes into `--cf-vt` — on iOS versions that scroll the layout viewport under the
 * keyboard rather than resizing it, the page has to be pushed back down by exactly that much or the
 * header disappears off the top.
 *
 * `interactive-widget=resizes-content` in `mobile.html` asks the browsers that support it to resize
 * the layout viewport too, which makes `offsetTop` stay 0 and the whole thing a no-op. This is the
 * fallback for the ones that do not, and there is no way to feature-detect which is which — so both
 * are always applied, and on a browser that already did the right thing they are already the right
 * values.
 */

/** Installs the listeners and applies the first measurement. Safe to call more than once. */
export function trackViewport(): void {
  const vv = window.visualViewport;
  const root = document.documentElement;

  const apply = () => {
    // No `visualViewport` at all is an old browser, and the honest answer there is the one CSS
    // already has: the fallback in `var(--cf-vh, 100%)`. Writing a measured pixel height from
    // `innerHeight` would be the same wrong number with more confidence behind it.
    if (!vv) return;
    root.style.setProperty("--cf-vh", `${vv.height}px`);
    root.style.setProperty("--cf-vt", `${vv.offsetTop}px`);
  };

  apply();
  if (!vv) return;
  // `resize` is the keyboard opening and closing and the device rotating; `scroll` is the visual
  // viewport being panned under a keyboard that is already up, which moves `offsetTop` without
  // changing the height. Both have to be followed or the layout drifts by however far the user
  // scrolled while typing.
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
}
