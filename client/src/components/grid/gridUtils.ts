// Caret-position helpers for the time grid cells. These are NOT styles — they
// gate ArrowLeft/ArrowRight cell navigation on whether the caret sits at an edge.
// (Formerly co-located in gridStyles.ts, which has been retired in favour of CSS Modules.)

export function caretAtStart(el: HTMLInputElement) {
  return el.selectionStart === 0 && el.selectionEnd === 0;
}
export function caretAtEnd(el: HTMLInputElement) {
  return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
}
