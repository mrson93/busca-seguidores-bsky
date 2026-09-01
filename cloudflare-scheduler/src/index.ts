const GITHUB_API_VERSION = "2022-11-28";

export type DispatchConfig = {
  owner: string;
  repository: string;
  workflow: string;
  ref: string;
  token: string;
};

export async function dispatchWorkflow(
  config: DispatchConfig,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const path = [
    "repos",
    config.owner,
    config.repository,
    "actions",
    "workflows",
    config.workflow,
    "dispatches",
  ]
    .map(encodeURIComponent)
    .join("/");

  const response = await fetcher(`https://api.github.com/${path}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "User-Agent": "busca-seguidores-bsky-scheduler",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: JSON.stringify({ ref: config.ref }),
  });

  if (response.status !== 204) {
    throw new Error(
      `GitHub recusou o disparo do workflow: ${response.status} ${response.statusText}`,
    );
  }
}

export default {
  async scheduled(controller, env): Promise<void> {
    const startedAt = new Date().toISOString();

    try {
      await dispatchWorkflow({
        owner: env.GITHUB_OWNER,
        repository: env.GITHUB_REPOSITORY,
        workflow: env.GITHUB_WORKFLOW,
        ref: env.GITHUB_REF,
        token: env.GITHUB_TOKEN,
      });

      console.log(
        JSON.stringify({
          event: "github_workflow_dispatched",
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          startedAt,
          status: "success",
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "github_workflow_dispatch_failed",
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          startedAt,
          status: "error",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
