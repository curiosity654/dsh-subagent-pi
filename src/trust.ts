import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type { CallId } from "@deepseek-ai/dsh-llm";

import { canonicalWorkspace } from "./workspace.js";

export interface ProjectTrustStoreLike {
  get(workspace: string): boolean | null;
  getEntry?(workspace: string): { path?: string; decision: boolean } | null;
  set(workspace: string, decision: boolean): void;
}

export interface ApprovalServiceLike {
  request(request: {
    agent: Agent;
    toolName: string;
    callId?: CallId;
    reason: string;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome>;
}

export interface TrustProjectInput {
  readonly parent: Agent;
  readonly store: ProjectTrustStoreLike;
  readonly approval?: ApprovalServiceLike;
  readonly callId?: CallId;
  readonly signal: AbortSignal;
}

export interface TrustProjectResult {
  readonly workspace: string;
  readonly trusted: true;
  readonly changed: boolean;
}

/**
 * Approve and persist trust for the exact top-level parent's canonical
 * workspace. Child runs cannot use this authority, and every post-approval
 * write is revalidated against the parent's current cwd.
 */
export async function trustProject(input: TrustProjectInput): Promise<TrustProjectResult> {
  throwIfAborted(input.signal);
  if (input.parent.session.header.parentSession !== undefined) {
    throw new Error("pi_trust_project is available only to a top-level DSH session");
  }
  const workspace = await canonicalWorkspace(input.parent.session.header.cwd);
  throwIfAborted(input.signal);
  const current: { path?: string; decision: boolean } | null = input.store.getEntry !== undefined
    ? input.store.getEntry(workspace)
    : (() => {
      const decision = input.store.get(workspace);
      return decision === null ? null : { decision };
    })();
  const exact = current === null || current === undefined || current.path === undefined || current.path === workspace;
  if (current?.decision === true && exact) return { workspace, trusted: true, changed: false };
  if (input.approval === undefined) throw new Error(`Project trust approval is unavailable for ${workspace}`);

  const reason = current?.decision === false
    ? `Trust project workspace ${workspace}; this overwrites the saved "do not trust" decision.`
    : current?.path !== undefined && current.path !== workspace
      ? `Trust project workspace ${workspace}; this persists an exact decision instead of inheriting trust from ${current.path}.`
    : `Trust project workspace ${workspace}.`;
  const approvalRequest = {
    agent: input.parent,
    toolName: "pi_trust_project",
    reason,
    signal: input.signal,
    ...(input.callId === undefined ? {} : { callId: input.callId }),
  } satisfies Parameters<ApprovalServiceLike["request"]>[0];
  const outcome = await input.approval.request(approvalRequest);
  if (outcome !== "allowed-once") throw new Error(`Project trust was not approved (${outcome})`);
  throwIfAborted(input.signal);

  if (input.parent.session.header.parentSession !== undefined) {
    throw new Error("Parent session changed while approval was pending");
  }
  const revalidatedWorkspace = await canonicalWorkspace(input.parent.session.header.cwd);
  if (revalidatedWorkspace !== workspace) throw new Error("Workspace changed while approval was pending");
  throwIfAborted(input.signal);

  input.store.set(workspace, true);
  const verified = input.store.getEntry?.(workspace);
  if (input.store.get(workspace) !== true || (verified?.path !== undefined && verified.path !== workspace) || verified?.decision === false) {
    throw new Error(`Project trust could not be persisted for ${workspace}`);
  }
  return { workspace, trusted: true, changed: true };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}
