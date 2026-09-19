// Who runs this deployment. An admin's account is held on the top plan: they
// are the ones testing what a paying member gets, so they are never stopped by
// a plan gate or a balance.
//
// This is deployment configuration rather than user data — like the plan
// catalog, it belongs to the product, not to a row someone edits. Set
// `ADMIN_EMAILS` (a comma-separated list) to change it without a deploy;
// setting it empty leaves the deployment with no admins at all.
const DEFAULT_ADMIN_EMAILS = ["lifewirecg@gmail.com"];

export function adminEmails() {
  const configured = process.env.ADMIN_EMAILS;
  const list = configured === undefined ? DEFAULT_ADMIN_EMAILS : configured.split(",");
  return list.map((email) => email.trim().toLowerCase()).filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}
