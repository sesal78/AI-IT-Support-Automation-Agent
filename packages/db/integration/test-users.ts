// Test users on the local GoTrue of the REST stack (P5-T15). TEST CODE ONLY.
// Every email and password is generated per call and is never printed: errors
// name the step and the HTTP status only, and the returned `email` and
// `password` are non-enumerable, so a failed `expect`, `console.log` or
// `JSON.stringify` of the user does not show them.
import { randomBytes } from "node:crypto";
import { clientFor } from "./pg-container.js";
import type { RestStack } from "./rest-stack.js";

export type StaffRole = "agent" | "admin";

export interface TestStaffUserOptions {
  /** With a role, a `staff` row is added for the user. Without one, the user is non-staff. */
  role?: StaffRole;
  /** The `staff.active` flag. Default true. Ignored without a role. */
  active?: boolean;
  /** Whether the email is confirmed. Default true. Unconfirmed users cannot sign in. */
  confirmed?: boolean;
}

export interface TestStaffUser {
  /** The GoTrue user id (`auth.users.id`). */
  userId: string;
  /** The `staff.id`, or undefined for a non-staff user. */
  staffId: string | undefined;
  /** Non-enumerable. */
  readonly email: string;
  /** Non-enumerable. */
  readonly password: string;
}

/**
 * Creates a GoTrue user through the admin API (sign-up is disabled on the
 * stack) and, if a role is given, the matching `itsupport.staff` row.
 */
export async function createTestStaffUser(
  stack: RestStack,
  options: TestStaffUserOptions = {},
): Promise<TestStaffUser> {
  const { role, active = true, confirmed = true } = options;
  const email = `staff-${randomBytes(6).toString("hex")}@example.test`;
  const password = randomBytes(24).toString("base64url");

  const res = await fetch(`${stack.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stack.serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: confirmed }),
  });
  if (!res.ok) throw new Error(`createTestStaffUser: GoTrue admin create failed (HTTP ${res.status})`);
  const { id: userId } = (await res.json()) as { id: string };

  let staffId: string | undefined;
  if (role !== undefined) staffId = await insertStaffRow(stack, { userId, email, role, active });

  const user = { userId, staffId } as TestStaffUser;
  Object.defineProperty(user, "email", { value: email, enumerable: false });
  Object.defineProperty(user, "password", { value: password, enumerable: false });
  return user;
}

async function insertStaffRow(
  stack: RestStack,
  row: { userId: string; email: string; role: StaffRole; active: boolean },
): Promise<string> {
  const db = clientFor(stack.pg);
  await db.connect();
  try {
    // TODO(P5-B2): `itsupport.staff` comes with migration 0007, which is not in
    // MIGRATIONS yet. Until it is, a staff user cannot be made and this throws;
    // drop the check once 0007 is in the list. Columns as in plan §6.3.1.
    const { rows } = await db.query<{ present: boolean }>(
      "select to_regclass('itsupport.staff') is not null as present",
    );
    if (!rows[0]?.present) {
      throw new Error(
        "createTestStaffUser: itsupport.staff does not exist on this stack; it comes with migration 0007 (P5-B2)",
      );
    }
    const inserted = await db.query<{ id: string }>(
      `insert into itsupport.staff (auth_user_id, email, display_name, role, active)
       values ($1, $2, $3, $4, $5) returning id`,
      [row.userId, row.email.toLowerCase(), `Test ${row.role}`, row.role, row.active],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("createTestStaffUser: staff insert returned no row");
    return id;
  } finally {
    await db.end().catch(() => undefined);
  }
}
