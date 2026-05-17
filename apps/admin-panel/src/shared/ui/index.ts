/**
 * Barrel for shared UI primitives and domain components.
 * Import from this path: `import { Card, Badge, Button } from "../../shared/ui";`
 */

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card.tsx";
export { Badge, badgeVariants } from "./badge.tsx";
export { Button, buttonVariants } from "./button.tsx";
export { Separator } from "./separator.tsx";
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger
} from "./tooltip.tsx";
export { BrandBlock } from "./brand-block.tsx";
export { ModeBadge } from "./mode-badge.tsx";
export { FreshnessTag } from "./freshness-tag.tsx";
export { Eyebrow } from "./eyebrow.tsx";
export { MetricCard } from "./metric-card.tsx";
export { ThemeToggle } from "./theme-toggle.tsx";
export { PageHeader } from "./page-header.tsx";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.tsx";
export { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion.tsx";
export { NoticeBanner } from "./notice-banner.tsx";
export { DefinitionList, type DefinitionRow as DefinitionRowItem } from "./definition-list.tsx";
export { Sparkline } from "./sparkline.tsx";
export { MiniBar } from "./mini-bar.tsx";
export { Stepper, type StepperStep, type StepStatus } from "./stepper.tsx";
export { AuditLogTable, type AuditLogEntry } from "./audit-log-table.tsx";
export { OpenClawPromptPanel } from "./openclaw-prompt-panel.tsx";
export { DarkCliSnippet, type CliLine, type CliLineTone } from "./dark-cli-snippet.tsx";
