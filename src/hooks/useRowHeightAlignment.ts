import { useEffect, useRef } from "react";

interface RowHeightAlignmentOptions {
  containerSelector: string;
  cardSelector: string;
  tagsSelector: string;
  trafficSelector?: string;
  dividerSelector?: string;
  enabled?: boolean;
}

export const useRowHeightAlignment = ({
  containerSelector,
  cardSelector,
  tagsSelector,
  trafficSelector,
  dividerSelector,
  enabled = true,
}: RowHeightAlignmentOptions) => {
  const rafRef = useRef<number | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;

    const alignHeights = () => {
      const container = document.querySelector(containerSelector);
      if (!container) return;

      const cards = Array.from(container.querySelectorAll(cardSelector)) as HTMLElement[];
      if (cards.length === 0) return;

      cards.forEach((card) => {
        const tags = card.querySelector(tagsSelector) as HTMLElement | null;
        const traffic = trafficSelector
          ? (card.querySelector(trafficSelector) as HTMLElement | null)
          : null;
        const divider = dividerSelector
          ? (card.querySelector(dividerSelector) as HTMLElement | null)
          : null;
        if (tags) tags.style.minHeight = "";
        if (traffic) traffic.style.height = "";
        if (divider) divider.style.marginTop = "";
      });

      const rows: HTMLElement[][] = [];
      let currentRow: HTMLElement[] = [];
      let currentTop = cards[0]?.getBoundingClientRect().top ?? 0;

      cards.forEach((card) => {
        const top = card.getBoundingClientRect().top;
        if (Math.abs(top - currentTop) > 1) {
          if (currentRow.length > 0) rows.push(currentRow);
          currentRow = [card];
          currentTop = top;
        } else {
          currentRow.push(card);
        }
      });
      if (currentRow.length > 0) rows.push(currentRow);

      rows.forEach((row) => {
        let maxTagsHeight = 0;
        let maxTrafficHeight = 0;

        row.forEach((card) => {
          const tags = card.querySelector(tagsSelector) as HTMLElement | null;
          const traffic = trafficSelector
            ? (card.querySelector(trafficSelector) as HTMLElement | null)
            : null;
          if (tags) maxTagsHeight = Math.max(maxTagsHeight, tags.offsetHeight);
          if (traffic) maxTrafficHeight = Math.max(maxTrafficHeight, traffic.offsetHeight);
        });

        row.forEach((card) => {
          const tags = card.querySelector(tagsSelector) as HTMLElement | null;
          const traffic = trafficSelector
            ? (card.querySelector(trafficSelector) as HTMLElement | null)
            : null;
          if (tags && maxTagsHeight > 0) tags.style.minHeight = `${maxTagsHeight}px`;
          if (traffic && maxTrafficHeight > 0) traffic.style.height = `${maxTrafficHeight}px`;
        });

        if (!dividerSelector || row.length < 2) return;

        const dividers = row
          .map((card) => {
            const divider = card.querySelector(dividerSelector) as HTMLElement | null;
            return divider
              ? { divider, top: divider.getBoundingClientRect().top }
              : null;
          })
          .filter((item): item is { divider: HTMLElement; top: number } => item !== null);
        if (dividers.length < 2) return;

        const targetTop = Math.max(...dividers.map(({ top }) => top));
        dividers.forEach(({ divider, top }) => {
          const extraOffset = targetTop - top;
          if (extraOffset <= 0.5) return;
          const baseMarginTop = Number.parseFloat(getComputedStyle(divider).marginTop) || 0;
          divider.style.marginTop = `${baseMarginTop + extraOffset}px`;
        });
      });
    };

    const scheduleAlign = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      timeoutRef.current = setTimeout(() => {
        rafRef.current = requestAnimationFrame(alignHeights);
      }, 100);
    };

    const resizeObserver = new ResizeObserver(scheduleAlign);
    const observeTargets = () => {
      const container = document.querySelector(containerSelector);
      if (!container) return;

      resizeObserver.disconnect();
      resizeObserver.observe(container);
      const cards = Array.from(container.querySelectorAll(cardSelector)) as HTMLElement[];
      cards.forEach((card) => {
        resizeObserver.observe(card);
        const tags = card.querySelector(tagsSelector);
        const traffic = trafficSelector ? card.querySelector(trafficSelector) : null;
        const divider = dividerSelector ? card.querySelector(dividerSelector) : null;
        if (tags) resizeObserver.observe(tags);
        if (traffic) resizeObserver.observe(traffic);
        if (divider) resizeObserver.observe(divider);
      });
    };

    const mutationObserver = new MutationObserver(() => {
      observeTargets();
      scheduleAlign();
    });

    observeTargets();
    const container = document.querySelector(containerSelector);
    if (container) mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });
    rafRef.current = requestAnimationFrame(alignHeights);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerSelector, cardSelector, tagsSelector, trafficSelector, dividerSelector, enabled]);
};
