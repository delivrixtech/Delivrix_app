/**
 * Building blocks v2 — rediseño profesional del panel (Hito 5.11.C).
 *
 * Diseñados en Pencil (frames qLtC3 Overview / o5lbP Canvas / jxinc Seguridad)
 * por Claude + portados a React directamente. Reusables, tokens.css only,
 * sin hex hardcoded.
 *
 * Canvas-specific blocks (PromptStripTop, LaneCard, TimelineLive,
 * DetailPanelFreshness) viven inline en features/canvas/index.tsx porque
 * son demasiado específicos para reuso.
 */

export { LiveIndicator, type LiveIndicatorProps } from "./LiveIndicator.tsx";
export { KpiCardV2, type KpiCardV2Props } from "./KpiCardV2.tsx";
export { SectionDivider, type SectionDividerProps } from "./SectionDivider.tsx";
export { BannerOpenClawV2, type BannerOpenClawV2Props } from "./BannerOpenClawV2.tsx";
export { ApprovalRow, type ApprovalRowProps, type ApprovalSeverity } from "./ApprovalRow.tsx";
export {
  ComplianceCardV2,
  type ComplianceCardV2Props,
  type ComplianceCardState
} from "./ComplianceCardV2.tsx";
export { IamRoleRow, type IamRoleRowProps, type IamRoleColor } from "./IamRoleRow.tsx";
export {
  IamSessionRow,
  type IamSessionRowProps,
  type IamSessionTransport,
  type IamSessionRisk
} from "./IamSessionRow.tsx";
export { KillSwitchV2, type KillSwitchV2Props, type KillSwitchState } from "./KillSwitchV2.tsx";
export { FeatureHeader, type FeatureHeaderProps } from "./FeatureHeader.tsx";
