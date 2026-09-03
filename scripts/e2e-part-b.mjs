import fs from "fs";
import { api, getTokens } from "./e2e-lib.mjs";

const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  t(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
};

const { admin: adminToken, org: orgToken, plain: plainToken } = await getTokens();

// resolve org uuid
const orgs = await api("GET", "/admin/organizations?page=1&limit=50", { token: adminToken });
const e2eOrg = orgs.data.data.items.find((o) => o.name === "AUDIT E2E ORG");
const E2E_ORG_UUID = e2eOrg.uuid;
t(`target org: ${e2eOrg.name} (${E2E_ORG_UUID})`);

// ─── 5. TEMPLATES ───
t("\n=== 5. TEMPLATES ===");
let tplUuid;
{
  const created = await api("POST", "/admin/templates", {
    token: adminToken,
    body: {
      organization_uuid: E2E_ORG_UUID,
      template_name: "E2E Degree Template",
      document_type: "Degree",
      fields: [
        { label: "Degree Name", required: true },
        { label: "Institution", required: true },
        { label: "Roll Number", required: false },
      ],
    },
  });
  show("admin create template", created);
  tplUuid = created.data?.data?.template?.uuid;

  const updated = await api("PUT", `/admin/templates/${tplUuid}`, {
    token: adminToken,
    body: {
      template_name: "E2E Degree Template v2",
      document_type: "Degree",
      fields: [
        { label: "Degree Name", required: true },
        { label: "Institution", required: true },
        { label: "Roll Number", required: false },
        { label: "Grade", required: false },
      ],
    },
  });
  show("admin edit template", updated, `name=${updated.data?.data?.template?.template_name}`);

  const orgCreated = await api("POST", "/org/templates", {
    token: orgToken,
    body: { template_name: "Org Experience Letter", fields: [{ label: "Employee Name", required: true }] },
  });
  show("org-admin create own template", orgCreated);

  const orgList = await api("GET", "/org/templates?page=1&limit=10", { token: orgToken });
  show("org-admin list templates (scoped)", orgList, `total=${orgList.data?.data?.total} names=[${(orgList.data?.data?.items ?? []).map((x) => x.template_name).join(", ")}]`);

  // IDOR: org-admin cannot edit another org's template — create second org template via admin then try
  const foreignTpl = await api("POST", "/admin/templates", {
    token: adminToken,
    body: { organization_uuid: null, template_name: "Platform-level tpl", fields: [] },
  });
  show("admin create platform-level template (no org)", foreignTpl);
}

// ─── 7. VERIFICATION REQUESTS (full lifecycle incl QR) ───
t("\n=== 7. VERIFICATION REQUESTS ===");
let reqUuid;
{
  const fd = new FormData();
  fd.append("document_type", "Degree");
  fd.append("issuing_organization_uuid", E2E_ORG_UUID);
  fd.append("submission_remarks", "e2e walkthrough request");
  fd.append("template_uuid", tplUuid);
  fd.append("template_data", JSON.stringify({ "Degree Name": "BSc CS", Institution: "E2E University", "Roll Number": "R-001" }));
  fd.append("document", new Blob([Buffer.from("%PDF-1.4 e2e-test-document")], { type: "application/pdf" }), "e2e-doc.pdf");

  const created = await api("POST", "/verification-requests", { token: plainToken, form: fd });
  show("plain user creates request w/ template -> E2E ORG", created);
  reqUuid = created.data?.data?.request?.uuid;
  t(`saved template_data: ${JSON.stringify(created.data?.data?.request?.template_data)}`);

  // missing required field rejected clearly?
  const fd2 = new FormData();
  fd2.append("document_type", "Degree");
  fd2.append("issuing_organization_uuid", E2E_ORG_UUID);
  fd2.append("template_uuid", tplUuid);
  fd2.append("template_data", JSON.stringify({ "Roll Number": "R-002" }));
  fd2.append("document", new Blob([Buffer.from("%PDF-1.4 x")], { type: "application/pdf" }), "e2e-doc2.pdf");
  const missingReq = await api("POST", "/verification-requests", { token: plainToken, form: fd2 });
  show("missing required template field (expect clear 400)", missingReq);

  // admin views + filters
  const all = await api("GET", "/admin/verification-requests?page=1&limit=10", { token: adminToken });
  show("admin list requests", all, `total=${all.data?.data?.total}`);
  const filtered = await api("GET", "/admin/verification-requests?status=under_review&page=1&limit=10", { token: adminToken });
  show("filter status=under_review", filtered, `total=${filtered.data?.data?.total}`);
  const dated = await api("GET", "/admin/verification-requests?date_from=2026-08-01&date_to=2026-08-21&page=1&limit=10", { token: adminToken });
  show("date range filter", dated, `total=${dated.data?.data?.total}`);
  const datedEmpty = await api("GET", "/admin/verification-requests?date_from=2020-01-01&date_to=2020-01-02&page=1&limit=10", { token: adminToken });
  show("date range filter (empty window)", datedEmpty, `total=${datedEmpty.data?.data?.total}`);

  // issuing org verifies via inbox flow
  const verified = await api("PATCH", `/verification-requests/${reqUuid}/verify`, {
    token: orgToken,
    body: { status: "verified", verification_remarks: "e2e verify by org" },
  });
  show("issuing org verifies request", verified);

  // QR certificate download by requester
  const cert = await api("GET", `/verification-requests/${reqUuid}/certificate`, { token: plainToken, raw: true });
  const buf = Buffer.from(await cert.arrayBuffer());
  t(`certificate download: HTTP ${cert.status} bytes=${buf.length} type=${cert.headers.get("content-type")} pdfMagic=${buf.slice(0, 5).toString()}`);

  // extract qr_token from DB-side response? use public endpoint with token from verify response
  const qrToken = verified.data?.data?.request?.qr_token;
  if (qrToken) {
    const pub = await api("GET", `/verify/${qrToken}`);
    show("public QR verify page API", pub, `valid=${pub.data?.data?.valid ?? JSON.stringify(pub.data?.data)?.slice(0, 80)}`);
    const tampered = qrToken.slice(0, -1) === "a" ? qrToken.slice(0, -1) + "b" : qrToken.slice(0, -1) + "a";
    const pubBad = await api("GET", `/verify/${tampered}`);
    show("public QR verify TAMPERED token (expect invalid/404)", pubBad, `status=${pubBad.status}`);
  } else {
    t("qr_token not present in verify response — checking cert endpoint only");
  }

  // verified request cannot be deleted
  const delVerified = await api("DELETE", `/verification-requests/my/sent/${reqUuid}`, { token: plainToken });
  show("delete VERIFIED request (expect block)", delVerified);

  // under_review request CAN be deleted by owner
  const fd3 = new FormData();
  fd3.append("document_type", "Transcript");
  fd3.append("issuing_organization_uuid", E2E_ORG_UUID);
  fd3.append("document", new Blob([Buffer.from("%PDF-1.4 y")], { type: "application/pdf" }), "e2e-doc3.pdf");
  const tmpReq = await api("POST", "/verification-requests", { token: plainToken, form: fd3 });
  const delOk = await api("DELETE", `/verification-requests/my/sent/${tmpReq.data?.data?.request?.uuid}`, { token: plainToken });
  show("delete under_review request (owner)", delOk);
}

// ─── 6. ORGANIZATIONS ───
t("\n=== 6. ORGANIZATIONS ===");
{
  const fd = new FormData();
  fd.append("name", "E2E New Org");
  fd.append("organization_type", "university");
  fd.append("business_email", "billing@e2eneworg.test");
  const created = await api("POST", "/admin/organizations", { token: adminToken, form: fd });
  show("create organization (+business_email)", created, `business_email=${created.data?.data?.organization?.business_email} verified=${created.data?.data?.organization?.verified}`);
  const orgUuid = created.data?.data?.organization?.uuid;

  const fdUp = new FormData();
  fdUp.append("name", "E2E New Org Updated");
  fdUp.append("organization_type", "university");
  fdUp.append("business_email", "hello@e2eneworg.test");
  const updated = await api("PUT", `/admin/organizations/${orgUuid}`, { token: adminToken, form: fdUp });
  show("edit organization", updated, `business_email=${updated.data?.data?.organization?.business_email}`);

  t("NOTE: no verify/unverify endpoint or UI control exists (orgs are created verified='yes' implicitly)");

  const deleted = await api("DELETE", `/admin/organizations/${orgUuid}`, { token: adminToken });
  show("delete organization", deleted);
}

fs.writeFileSync("./e2e-results-b.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));
