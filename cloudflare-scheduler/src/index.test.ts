import { describe, expect, it, vi } from "vitest";

import { dispatchWorkflow } from "./index";

const config = {
  owner: "mrson93",
  repository: "busca-seguidores-bsky",
  workflow: "auto-follow.yml",
  ref: "main",
  token: "token-de-teste",
};

describe("dispatchWorkflow", () => {
  it("dispara o workflow correto sem enviar o token no corpo", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await dispatchWorkflow(config, fetcher);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/mrson93/busca-seguidores-bsky/actions/workflows/auto-follow.yml/dispatches",
    );
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer token-de-teste",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(options?.body).toBe('{"ref":"main"}');
    expect(String(options?.body)).not.toContain(config.token);
  });

  it("falha quando o GitHub não aceita o disparo", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 403, statusText: "Forbidden" }),
    );

    await expect(dispatchWorkflow(config, fetcher)).rejects.toThrow(
      "GitHub recusou o disparo do workflow: 403 Forbidden",
    );
  });
});
