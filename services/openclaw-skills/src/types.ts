export interface SkillDescriptor {
  slug: string;
  displayName: string;
  description: string;
  triggerPhrases: string[];
  declaredActions: string[];
  schemaVersion: "2026-05-18.v1";
  modelHint: string;
}

export interface SkillContext {
  utterance?: string;
}

export interface SkillResponse {
  output: string;
  metadata: Record<string, unknown>;
}

export interface SkillModule {
  descriptor: SkillDescriptor;
  handler?: (ctx: SkillContext) => Promise<SkillResponse>;
}
