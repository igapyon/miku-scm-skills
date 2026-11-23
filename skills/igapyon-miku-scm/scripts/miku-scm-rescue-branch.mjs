import { gitEvidenceText, parseEvidence, readEvidenceCandidate, registeredWorktreeRoots } from "./miku-scm-worktree-evidence.mjs";

export const DONE_RESCUE_PREFIX = "rescue/done/";

const LEGACY_BACKUP_PREFIX = "backup/done-recovery-";
const LEGACY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_MODES = new Set(["rescue", "integrated"]);
const LEGACY_STATES = new Set(["running", "partial", "completed"]);
const LEGACY_WORK_BRANCH = /^.+-tiga\d{4}[a-x][a-j][a-j]$/;

function hasLegacyRecoveryJournal(worktree, branch, backups) {
  for (const [id, head] of backups) {
    const record = parseEvidence(readEvidenceCandidate(worktree, "done-recovery", `${id}.json`));
    if (record?.schema_version === "miku-scm.done-recovery/v1"
      && record.id === id && record.backup_branch === `${LEGACY_BACKUP_PREFIX}${id}`
      && LEGACY_MODES.has(record.mode) && LEGACY_STATES.has(record.status)
      && typeof record.previous_branch === "string" && record.previous_branch.endsWith("-done")
      && record.initial_head === head
      && record.next_branch === branch && record.next_branch !== record.previous_branch) return true;
  }
  return false;
}

function isLegacyRecoveryBranch(root, branch, git) {
  if (!LEGACY_WORK_BRANCH.test(branch)) return false;
  const refs = gitEvidenceText(git, root, ["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)", "refs/heads/backup"]);
  const backups = new Map();
  for (const line of refs.split("\n")) {
    const [ref, head] = line.split("\0");
    if (!ref.startsWith(LEGACY_BACKUP_PREFIX)) continue;
    const id = ref.slice(LEGACY_BACKUP_PREFIX.length);
    if (LEGACY_ID.test(id)) backups.set(id, head);
  }
  if (!backups.size) return false;
  // v1 created local rescues from a full SHA. The branch reflog and backup
  // survive removal of the worktree that held the v1 journal.
  const reflog = gitEvidenceText(git, root, ["reflog", "show", "--format=%H%x00%gs", `refs/heads/${branch}`]);
  const savedHeads = new Set(backups.values());
  if (reflog.split("\n").some((line) => {
    const [head, message] = line.split("\0");
    return savedHeads.has(head) && message === `branch: Created from ${head}`;
  })) return true;

  return registeredWorktreeRoots(root, git).some((worktree) => hasLegacyRecoveryJournal(worktree, branch, backups));
}

export function assertNotDoneRescueBranch(root, branch, git) {
  if (branch.startsWith(DONE_RESCUE_PREFIX)
    || isLegacyRecoveryBranch(root, branch, git)) {
    throw new Error("Rescue branch is local only. Move the reviewed recovery to a new work branch before syncing or publishing.");
  }
}
