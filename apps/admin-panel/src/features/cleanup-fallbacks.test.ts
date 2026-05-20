import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface LearningModule {
  buildSkillRows: (signals: {
    recommendations?: Array<{ id: string; label: string; status: string }>;
  }) => Array<{ title: string; endpoint: string; state: string }>;
}

interface OnboardingModule {
  buildOnboardingSteps: (state: {
    readinessByCategory?: Record<string, number>;
    pendingQuestions?: Array<{ category: string }>;
    blockers?: string[];
  }) => Array<{ title: string; category: string; pendingQuestions: number; blockers: number; score: number | null }>;
  activeStepIndex: (steps: Array<{ score: number | null; pendingQuestions: number; blockers: number }>) => number;
}

interface SafetyModule {
  buildSafetyAuditRows: (data: {
    auditEvents: Array<{
      id: string;
      occurredAt: string;
      actorType: string;
      actorId: string;
      action: string;
      targetType: string;
      targetId: string;
      riskLevel: string;
    }>;
  }) => Array<{ action: string; actor: string; resource: string; result: string }>;
}

let server: ViteDevServer | null = null;

async function loadModule<T>(path: string): Promise<T> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });

  return server.ssrLoadModule(path) as Promise<T>;
}

after(async () => {
  await server?.close();
});

test("fallback cleanup mappers keep empty contracts empty", async () => {
  const learning = await loadModule<LearningModule>("/src/features/learning/index.tsx");
  const onboarding = await loadModule<OnboardingModule>("/src/features/onboarding/index.tsx");
  const safety = await loadModule<SafetyModule>("/src/features/safety/index.tsx");

  assert.deepEqual(learning.buildSkillRows({ recommendations: [] }), []);
  assert.deepEqual(onboarding.buildOnboardingSteps({
    readinessByCategory: {},
    pendingQuestions: [],
    blockers: []
  }), []);
  assert.deepEqual(safety.buildSafetyAuditRows({ auditEvents: [] }), []);
});

test("fallback cleanup mappers render rows from real contract fields", async () => {
  const learning = await loadModule<LearningModule>("/src/features/learning/index.tsx");
  const onboarding = await loadModule<OnboardingModule>("/src/features/onboarding/index.tsx");
  const safety = await loadModule<SafetyModule>("/src/features/safety/index.tsx");

  const skillRows = learning.buildSkillRows({
    recommendations: [
      {
        id: "collect_hardware_capacity",
        label: "Recolectar capacidad real antes de planear VPS.",
        status: "needs_review"
      }
    ]
  });
  assert.equal(skillRows.length, 1);
  assert.equal(skillRows[0].title, "Recolectar capacidad real antes de planear VPS.");
  assert.equal(skillRows[0].endpoint, "collect_hardware_capacity");
  assert.equal(skillRows[0].state, "en curso");

  const steps = onboarding.buildOnboardingSteps({
    readinessByCategory: { infrastructure: 0, network: 1, total: 0.5 },
    pendingQuestions: [{ category: "server" }, { category: "ip_pool" }],
    blockers: ["missing_server_model", "missing_provider_or_isp_approval"]
  });
  assert.deepEqual(steps.map((step) => step.title), ["Servidor", "IPs y dominios"]);
  assert.equal(steps[0].pendingQuestions, 1);
  assert.equal(steps[0].blockers, 1);
  assert.equal(onboarding.activeStepIndex(steps), 0);

  const auditRows = safety.buildSafetyAuditRows({
    auditEvents: [
      {
        id: "audit-real-001",
        occurredAt: "2026-05-20T16:10:10.826Z",
        actorType: "operator",
        actorId: "op-juanes-a",
        action: "operating_north.gate.checked",
        targetType: "gate",
        targetId: "human_approval",
        riskLevel: "low"
      }
    ]
  });
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].actor, "operator.op-juanes-a");
  assert.equal(auditRows[0].resource, "gate · human_approval");
  assert.equal(auditRows[0].result, "low");
});
