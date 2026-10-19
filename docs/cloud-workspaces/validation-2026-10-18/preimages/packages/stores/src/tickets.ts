import { Layer, type ScopeToken } from "@foundry/gate-ts";

export interface TaskTicket {
  taskId: string;
  baseRepo: string;
  /** Base head sha at fork time (fork point; "" when base is empty). */
  baseSha: string;
  forkRepo: string;
  agentId: string;
  scope: ScopeToken;
  /** Declared PACT chains for the task; the gate checks them when configured. */
  chains?: string[];
}

export interface TicketStore {
  getTicketByFork(forkRepo: string): Promise<TaskTicket | null>;
  saveTicket(ticket: TaskTicket): Promise<void>;
}

export class InMemoryTicketStore implements TicketStore {
  private byFork = new Map<string, TaskTicket>();

  async getTicketByFork(forkRepo: string): Promise<TaskTicket | null> {
    return this.byFork.get(forkRepo) ?? null;
  }

  async saveTicket(ticket: TaskTicket): Promise<void> {
    this.byFork.set(ticket.forkRepo, ticket);
  }
}

type TicketRow = {
  task_id: string;
  base_repo: string;
  base_sha: string;
  fork_repo: string;
  agent_id: string;
  scope_json: string;
};

export function serializeScope(scope: ScopeToken): string {
  return JSON.stringify({
    ...scope,
    allowed_layers: {
      min: scope.allowed_layers.min.value,
      max: scope.allowed_layers.max.value,
    },
  });
}

function layerValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { value?: unknown }).value === "number"
  ) {
    return (v as { value: number }).value;
  }
  throw new Error(`invalid layer value: ${JSON.stringify(v)}`);
}

export function reviveScope(json: string): ScopeToken {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const layers = raw.allowed_layers as { min: unknown; max: unknown };
  return {
    ...(raw as unknown as ScopeToken),
    allowed_layers: {
      min: new Layer(layerValue(layers.min)),
      max: new Layer(layerValue(layers.max)),
    },
  };
}

export class D1TicketStore implements TicketStore {
  constructor(private db: D1Database) {}

  async getTicketByFork(forkRepo: string): Promise<TaskTicket | null> {
    const row = await this.db
      .prepare("SELECT * FROM tickets WHERE fork_repo = ?")
      .bind(forkRepo)
      .first<TicketRow>();
    if (!row) return null;
    return {
      taskId: row.task_id,
      baseRepo: row.base_repo,
      baseSha: row.base_sha,
      forkRepo: row.fork_repo,
      agentId: row.agent_id,
      scope: reviveScope(row.scope_json),
    };
  }

  async saveTicket(ticket: TaskTicket): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tickets
         (task_id, base_repo, base_sha, fork_repo, agent_id, scope_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (fork_repo) DO UPDATE SET
           task_id = excluded.task_id, base_repo = excluded.base_repo,
           base_sha = excluded.base_sha, agent_id = excluded.agent_id,
           scope_json = excluded.scope_json`,
      )
      .bind(
        ticket.taskId,
        ticket.baseRepo,
        ticket.baseSha,
        ticket.forkRepo,
        ticket.agentId,
        serializeScope(ticket.scope),
      )
      .run();
  }
}
