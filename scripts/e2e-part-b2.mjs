import fs from "fs";
import { api, getTokens } from "./e2e-lib.mjs";

const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  t(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
};

const { admin: adminToken, org: orgToken, member: memberToken } = await getTokens();

// ─── 5b. TEMPLATES (corrected payloads) ───
t("\n=== 5b. TEMPLATES corrected ===");
let tplUuid;
{
  const orgCreated = await api("POST", "/org/templates", {
    token: orgToken,
    body: { template_name: "Org Experience Letter", document_type: "Experience Letter", fields: [{ label: "Employee Name", required: true }] },
  });
  show("org-admin create own template", orgCreated);
  tplUuid = orgCreated.data?.data?.template?.uuid;

  const tplEdited = await api("PUT", `/org/templates/${tplUuid}`, {
    token: orgToken,
    body: { template_name: "Org Experience Letter v2", document_type: "Experience Letter", fields: [{ label: "Employee Name", required: true }, { label: "Tenure", required: false }] },
  });
  show("org-admin edit own template", tplEdited, `name=${tplEdited.data?.data?.template?.template_name}`);

  const del = await api("DELETE", `/org/templates/${tplUuid}`, { token: orgToken });
  show("org-admin delete own template", del);

  // recreate for request flow
  const recreated = await api("POST", "/org/templates", {
    token: orgToken,
    body: { template_name: "E2E Member Form", document_type: "Degree", fields: [{ label: "Degree Name", required: true }, { label: "Institution", required: true }, { label: "Roll Number", required: false }] },
  });
  tplUuid = recreated.data?.data?.template?.uuid;
}

// ─── 7b. REQUESTS with correct template owner (member of E2E ORG) ───
t("\n=== 7b. VERIFICATION REQUESTS full lifecycle ===");
let reqUuid;
{
  const fd = new FormData();
  fd.append("document_type", "Degree");
  fd.append("issuing_organization_uuid", "");
  fd.append("other_organization_name", "E2E Target University");
  fd.append("submission_remarks", "e2e walkthrough");
  fd.append("template_uuid", tplUuid);
  fd.append("template_data", JSON.stringify({ "Degree Name": "BSc CS", Institution: "E2E University", "Roll Number": "R-001" }));
  fd.append("document", new Blob([Buffer.from("%PDF-1.4 e2e-test-document")], { type: "application/pdf" }), "e2e-doc.pdf");

  const created = await api("POST", "/verification-requests", { token: memberToken, form: fd });
  show("member creates request w/ own-org template", created);
  reqUuid = created.data?.data?.request?.uuid;
  t(`saved template_data: ${JSON.stringify(created.data?.data?.request?.template_data)}`);

  // missing required field
  const fd2 = new FormData();
  fd2.append("document_type", "Degree");
  fd2.append("other_organization_name", "E2E Target University");
  fd2.append("template_uuid", tplUuid);
  fd2.append("template_data", JSON.stringify({ "Roll Number": "R-002" }));
  fd2.append("document", new Blob([Buffer.from("%PDF-1.4 x")], { type: "application/pdf" }), "e2e-doc2.pdf");
  const missingReq = await api("POST", "/verification-requests", { token: memberToken, form: fd2 });
  show("missing required template field (expect clear 400)", missingReq);
}

fs.writeFileSync("./e2e-results-b2.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));
