import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubAppConfig } from "./config.js";

export class GitHubAppAuthManager {
  private auth: ReturnType<typeof createAppAuth>;
  private botLogin?: string;

  constructor(private config: GitHubAppConfig) {
    this.auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  /** Installation-scoped Octokit plus the raw token (needed for git fetch of the PR head). */
  public async getInstallationClient(
    installationId: number,
  ): Promise<{ octokit: Octokit; token: string }> {
    const { token } = await this.auth({ type: "installation", installationId });
    return { octokit: new Octokit({ auth: token }), token };
  }

  /**
   * Octokit authenticated as the App itself (JWT), for /app endpoints such as the webhook config.
   * auth-app's request hook does not route those to the JWT, so the token is minted explicitly;
   * it expires after 10 minutes, so take a fresh client per use.
   */
  public async getAppOctokit(): Promise<Octokit> {
    const { token } = await this.auth({ type: "app" });
    return new Octokit({ auth: token });
  }

  /** Login the App posts reviews as (`<slug>[bot]`), looked up once with the App's JWT. */
  public async getBotLogin(): Promise<string> {
    if (!this.botLogin) {
      const { data: app } = await (await this.getAppOctokit()).rest.apps.getAuthenticated();
      if (!app?.slug) throw new Error("Cannot resolve the GitHub App's slug.");
      this.botLogin = `${app.slug}[bot]`;
    }
    return this.botLogin;
  }

  /**
   * Generates an Octokit client authenticated as the specific installation (single-tenant organization).
   */
  public async getInstallationOctokit(installationId: number): Promise<Octokit> {
    const installationAuth = await this.auth({
      type: "installation",
      installationId,
    });
    return new Octokit({
      auth: installationAuth.token,
    });
  }

  /**
   * For single-tenant private setup, automatically fetches the first installation ID if not explicitly known.
   */
  public async getDefaultInstallationId(): Promise<number> {
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
      },
    });
    const installations = await appOctokit.rest.apps.listInstallations();
    if (!installations.data.length) {
      throw new Error("No installations found for this GitHub App.");
    }
    return installations.data[0].id;
  }
}
