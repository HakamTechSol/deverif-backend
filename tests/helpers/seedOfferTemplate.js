/**
 * Seeds ONE active `offer` letter template for an org.
 *
 * WHY EVERY RECRUITMENT FIXTURE NEEDS THIS.
 *
 * `hireCandidate` resolves the org's active offer template rather than trusting a
 * `templateUuid` from the caller, and refuses the hire when there is none. That guard
 * exists because a template-less draft letter cannot be issued — `issueLetter` renders
 * from the template body and throws "This letter has no template to render from".
 *
 * Before the guard, every hire produced exactly such a letter, because the UI has no
 * field for a template UUID: a recruiter confirms a hire with a CNIC and a joining
 * date. So hire succeeded and send always failed, and the failure appeared to be about
 * issuing rather than about the hire.
 *
 * Exporting the seeder keeps the guard and its fixtures honest — if a test expects a
 * hire to succeed it must say why a letter CAN be produced, and if it expects a hire to
 * fail it must omit this deliberately.
 */
export async function seedOfferTemplate(conn, orgId, { name = "Default Offer", seq = 0 } = {}) {
  const body = [
    "Dear {{candidate_name}},",
    "",
    "We are pleased to offer you the role of {{designation}} at our organisation.",
    "Your annual salary is {{salary}}.",
    "",
    "Please confirm your acceptance at your earliest convenience.",
    "",
    "Warm regards,",
    "Human Resources",
  ].join("\n");

  const [row] = await conn.query(
    `INSERT INTO letter_templates (uuid, organization_id, letter_type, name, body, merge_fields, is_active)
     VALUES (UUID(), ?, 'offer', ?, ?, ?, 1)`,
    [
      orgId,
      `${name}${seq ? ` ${seq}` : ""}`,
      body,
      JSON.stringify(["candidate_name", "designation", "salary"]),
    ],
  );

  return row.uuid;
}