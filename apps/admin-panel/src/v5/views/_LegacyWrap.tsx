/**
 * v5 LegacyWrap — envuelve componentes viejos con PageHead consistente
 * mientras los rediseñamos individualmente. Mientras tanto comparten el
 * shell visual nuevo (dark/light theme + sidebar + topbar + footer).
 */
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { staggerContainer, staggerItem } from "../lib/motion";
import { PageHead, type PageHeadProps } from "./_PageHead";

export interface LegacyWrapProps extends Partial<PageHeadProps> {
  children: ReactNode;
  /** Si la vista vieja ya tiene su propio hero h1, saltar el PageHead v5. */
  noHead?: boolean;
}

export function LegacyWrap({ children, noHead, title, ...head }: LegacyWrapProps) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      {!noHead && title ? (
        <motion.div variants={staggerItem}>
          <PageHead title={title} {...head} />
        </motion.div>
      ) : null}
      <motion.div variants={staggerItem}>{children}</motion.div>
    </motion.div>
  );
}
