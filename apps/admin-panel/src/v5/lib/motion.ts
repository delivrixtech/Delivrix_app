import type { Variants } from "framer-motion";

export const easeOutExpo = [0.16, 1, 0.3, 1] as const;

export const durations = {
  fast: 0.12,
  base: 0.18,
  page: 0.22
} as const;

export const staggerContainer: Variants = {
  initial: { opacity: 1 },
  animate: {
    opacity: 1,
    transition: {
      staggerChildren: 0.045,
      delayChildren: 0.015
    }
  }
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: durations.page, ease: easeOutExpo }
  }
};

export const sidebarSlide: Variants = {
  expanded: { width: 256 },
  collapsed: { width: 64 }
};
