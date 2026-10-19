/**
 * Hierarchical AbortController Tree.
 * Allows root task cancellation to cleanly cascade into subtasks, LLM calls, and async tool executions.
 */
export class TaskCancellationTree {
  private controller: AbortController;
  private children: TaskCancellationTree[] = [];
  private parent?: TaskCancellationTree;

  constructor(parent?: TaskCancellationTree) {
    this.controller = new AbortController();
    this.parent = parent;

    if (parent) {
      parent.children.push(this);
      if (parent.isAborted) {
        this.abort("Parent task was already aborted");
      } else {
        parent.signal.addEventListener("abort", () => {
          this.abort(parent.signal.reason);
        });
      }
    }
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isAborted(): boolean {
    return this.controller.signal.aborted;
  }

  public createChild(): TaskCancellationTree {
    return new TaskCancellationTree(this);
  }

  public abort(reason?: string): void {
    if (!this.isAborted) {
      this.controller.abort(reason || "Task cancelled");
      for (const child of this.children) {
        child.abort(reason);
      }
    }
  }

  public detach(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = undefined;
    }
  }
}
