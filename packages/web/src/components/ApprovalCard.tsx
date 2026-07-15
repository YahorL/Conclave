import { useState } from "react";
import type { Message } from "@conclave/shared";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./ApprovalCard.module.css";

function parseBody(body: string): { approvalId: string; action: string } {
  try {
    const parsed = JSON.parse(body) as { approvalId?: string; action?: string };
    return { approvalId: parsed.approvalId ?? "", action: parsed.action ?? body };
  } catch {
    return { approvalId: "", action: body };
  }
}

export function ApprovalCard({ message }: { message: Message }): JSX.Element {
  const { approvalId, action } = parseBody(message.body);
  const approval = useConclaveStore((s) => (approvalId ? s.approvalsById[approvalId] : undefined));
  const [note, setNote] = useState("");
  const state = approval?.state ?? "pending";
  const canDecide = approval?.state === "pending";

  const decide = (decision: "approved" | "denied"): void => {
    if (!approval) return;
    void hubClient.decideApproval(approval.id, decision, note.trim() || undefined).catch(() => undefined);
  };

  return (
    <div className={styles.card} data-testid="approval-card">
      <div className={styles.header}>
        <span className={styles.title}>approval requested by {message.from}</span>
        <span className={styles.chip} data-state={state} data-testid="approval-state">
          {state.toUpperCase()}
        </span>
      </div>
      <div className={styles.action}>{action}</div>
      {approval?.note && <div className={styles.note}>note: {approval.note}</div>}
      {canDecide && (
        <div className={styles.controls}>
          <input
            className={styles.noteInput}
            data-testid="approval-note"
            placeholder="optional note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className={styles.approve} data-testid="approval-approve" onClick={() => decide("approved")}>
            Approve
          </button>
          <button className={styles.deny} data-testid="approval-deny" onClick={() => decide("denied")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
