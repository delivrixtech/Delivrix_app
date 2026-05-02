import type { SendRequest } from "./types.ts";
import type { SuppressionList } from "./suppression-list.ts";

export type PolicyViolationCode =
  | "RECIPIENT_SUPPRESSED"
  | "MISSING_RECIPIENT"
  | "MISSING_CONSENT_PROOF"
  | "MISSING_SENDER"
  | "MISSING_SENDER_DOMAIN"
  | "MISSING_SUBJECT"
  | "MISSING_BODY"
  | "MISSING_UNSUBSCRIBE_URL"
  | "MISSING_PHYSICAL_ADDRESS"
  | "SENDER_DOMAIN_MISMATCH";

export interface PolicyViolation {
  code: PolicyViolationCode;
  message: string;
}

export interface PolicyDecision {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: string[];
}

export class MailPolicyEngine {
  private readonly suppressionList: SuppressionList;

  constructor(suppressionList: SuppressionList) {
    this.suppressionList = suppressionList;
  }

  async evaluate(request: SendRequest): Promise<PolicyDecision> {
    const violations: PolicyViolation[] = [];
    const warnings: string[] = [];
    const recipientEmail = request.recipient?.email?.trim();
    const senderAddress = request.sender?.address?.trim();
    const senderDomain = request.sender?.domain?.trim().toLowerCase();

    if (!recipientEmail) {
      violations.push({
        code: "MISSING_RECIPIENT",
        message: "Recipient email is required."
      });
    } else {
      const suppression = await this.suppressionList.isSuppressed(recipientEmail);
      if (suppression) {
        violations.push({
          code: "RECIPIENT_SUPPRESSED",
          message: `Recipient is suppressed because of ${suppression.reason}.`
        });
      }
    }

    if (!senderAddress) {
      violations.push({
        code: "MISSING_SENDER",
        message: "Sender address is required."
      });
    }

    if (!senderDomain) {
      violations.push({
        code: "MISSING_SENDER_DOMAIN",
        message: "Sender domain is required."
      });
    }

    if (senderAddress && senderDomain && !senderAddress.toLowerCase().endsWith(`@${senderDomain}`)) {
      violations.push({
        code: "SENDER_DOMAIN_MISMATCH",
        message: "Sender address must belong to the declared sender domain."
      });
    }

    if (!request.subject?.trim()) {
      violations.push({
        code: "MISSING_SUBJECT",
        message: "Subject is required and must not be misleading."
      });
    }

    if (!request.bodyText?.trim()) {
      violations.push({
        code: "MISSING_BODY",
        message: "Body text is required."
      });
    }

    if (request.classification === "commercial") {
      if (!request.recipient?.consentProofId?.trim()) {
        violations.push({
          code: "MISSING_CONSENT_PROOF",
          message: "Commercial mail requires a consent or authorization proof id."
        });
      }

      if (!request.unsubscribeUrl?.trim()) {
        violations.push({
          code: "MISSING_UNSUBSCRIBE_URL",
          message: "Commercial mail requires a functional unsubscribe URL."
        });
      }

      if (!request.physicalAddress?.trim()) {
        violations.push({
          code: "MISSING_PHYSICAL_ADDRESS",
          message: "Commercial mail requires a valid physical mailing address."
        });
      }
    }

    if (request.classification !== "commercial" && request.unsubscribeUrl) {
      warnings.push("Non-commercial message includes unsubscribe URL; verify classification is correct.");
    }

    return {
      allowed: violations.length === 0,
      violations,
      warnings
    };
  }
}
