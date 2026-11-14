import { useEffect, type RefObject } from "react";

/* Masonry for the side cards. The CSS makes the aside a grid with tiny rows;
   here each card is told how many of those rows it covers, measured from its
   real height. Cards never share space, and a card that grows (a spectrum
   result, an open tooltip) just pushes the cards below it down.
   CSS columns did this before, but Chrome repainted them badly when content
   changed or the page was zoomed, so text was drawn over other cards. */
export function useMasonry(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const place = (card: HTMLElement) => {
      const s = getComputedStyle(grid);
      if (s.display !== "grid") { card.style.gridRowEnd = ""; return; }
      const row = parseFloat(s.gridAutoRows) || 4;
      const gap = parseFloat(s.rowGap) || 0;
      const h = card.getBoundingClientRect().height + (parseFloat(getComputedStyle(card).marginBottom) || 0);
      card.style.gridRowEnd = `span ${Math.max(1, Math.ceil((h + gap) / (row + gap)))}`;
    };
    const all = () => Array.from(grid.children).forEach((c) => place(c as HTMLElement));
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === grid) all();
        else place(e.target as HTMLElement);
      }
    });
    ro.observe(grid);
    Array.from(grid.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [ref]);
}
