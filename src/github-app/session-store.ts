import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewSession } from "../domain/session.js";

/**
 * Review conversations per PR, as JSON files under `.pr-agent/pr-sessions`. A session is saved only
 * after its review was posted, so it always matches the PR's latest review by this App.
 */
export class PRSessionStore {
  constructor(private baseDir = path.join(process.cwd(), ".pr-agent", "pr-sessions")) {}

  private file(owner: string, repo: string, pullNumber: number): string {
    const safe = (s: string) => s.replace(/[^\w.-]/g, "_");
    return path.join(this.baseDir, safe(owner), safe(repo), `${pullNumber}.json`);
  }

  public load(owner: string, repo: string, pullNumber: number): ReviewSession | undefined {
    try {
      const session = JSON.parse(
        fs.readFileSync(this.file(owner, repo, pullNumber), "utf-8"),
      ) as ReviewSession;
      return session.version === 1 ? session : undefined;
    } catch {
      return undefined; // missing or unreadable: the review starts fresh
    }
  }

  public save(owner: string, repo: string, pullNumber: number, session: ReviewSession): void {
    const target = this.file(owner, repo, pullNumber);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write then rename, so a crash never leaves a truncated session behind.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session), "utf-8");
    fs.renameSync(tmp, target);
  }

  public delete(owner: string, repo: string, pullNumber: number): void {
    fs.rmSync(this.file(owner, repo, pullNumber), { force: true });
  }
}
