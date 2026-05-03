export const READ_ENDPOINTS = Object.freeze({
  health: "/health",
  adminClusters: "/v1/admin/clusters",
  adminOverview: "/v1/admin/overview",
  adminWorkflow: "/v1/admin/workflow",
  openClawLearningPlan: "/v1/openclaw/learning-plan",
  operatingNorth: "/v1/operating-north",
  killSwitch: "/v1/kill-switch"
});

export function listReadEndpoints() {
  return Object.values(READ_ENDPOINTS);
}

export async function loadDashboardData() {
  const [
    health,
    adminClusters,
    adminOverview,
    adminWorkflow,
    openClawLearningPlan,
    operatingNorth,
    killSwitch
  ] = await Promise.all([
    getJson(READ_ENDPOINTS.health),
    getJson(READ_ENDPOINTS.adminClusters),
    getJson(READ_ENDPOINTS.adminOverview),
    getJson(READ_ENDPOINTS.adminWorkflow),
    getJson(READ_ENDPOINTS.openClawLearningPlan),
    getJson(READ_ENDPOINTS.operatingNorth),
    getJson(READ_ENDPOINTS.killSwitch)
  ]);

  return {
    health,
    clusters: adminClusters.clusterOverview,
    overview: adminOverview.overview,
    workflow: adminWorkflow.workflow,
    learningPlan: openClawLearningPlan.learningPlan,
    operatingNorth,
    killSwitch: killSwitch.killSwitch
  };
}

async function getJson(endpoint) {
  assertReadEndpoint(endpoint);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : `GET ${endpoint} failed.`;
    throw new Error(message);
  }

  return payload;
}

export function assertReadEndpoint(endpoint) {
  if (!listReadEndpoints().includes(endpoint)) {
    throw new Error(`Endpoint is outside the admin panel read boundary: ${endpoint}`);
  }

  return true;
}
