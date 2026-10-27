import { getApprovalPolicy, setApprovalPolicy } from "../../services/approvalWorkflow.service.js";
import { ok } from "../../utils/response.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

export async function getApprovalPolicyHandler(req, res) {
  const policy = await getApprovalPolicy(req.scopeOrgId);
  return ok(res, policy, "Approval policy");
}

export async function updateApprovalPolicyHandler(req, res) {
  const value = req.body?.strict_dual_control;
  const policy = await setApprovalPolicy(req.scopeOrgId, {
    strictDualControl: value === true || value === 1 || value === "1" || value === "true",
  });
  logAudit({
    ...getActorFromReq(req),
    action: "approval_policy.update",
    entityType: "organization_approval_policy",
    entityId: String(req.scopeOrgId),
    details: policy,
    req,
  });
  return ok(res, policy, "Approval policy updated");
}
