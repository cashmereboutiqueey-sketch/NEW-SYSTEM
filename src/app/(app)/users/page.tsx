import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { listUsers, assignableRoles } from "@/lib/users";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatNumber } from "@/lib/money";
import { NewUserForm } from "./new-user-form";
import { UserActions } from "./user-actions";

/**
 * المستخدمون — who may sign in, and as what.
 *
 * The authorisation model was written before there was any way to create the
 * people it governs, so twelve roles and a careful segregation of duties sat
 * behind three seeded accounts. This is what makes the rest of it real.
 *
 * Nobody is deleted here. Every journal line, sale and stock adjustment names
 * the person who made it, and removing the row would orphan that history. An
 * account that should not be used is switched off.
 */
export default async function UsersPage() {
  const session = await requirePermission("user:manage");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [users, roles] = await Promise.all([listUsers(), assignableRoles()]);

  const active = users.filter((u) => u.isActive);
  const locked = users.filter((u) => u.isLocked);
  const pending = users.filter((u) => u.mustChangePassword && u.isActive);
  const owners = active.filter((u) => u.role === "OWNER");

  const roleLabel = (role: string) =>
    ar
      ? ({
          OWNER: "مالك", ACCOUNTANT: "محاسب", PRODUCTION: "إنتاج", VIEWER: "مشاهدة",
          BRAND_MANAGER: "مدير البراند", MODERATOR: "مودريتور", POS_CASHIER: "كاشير",
          WAREHOUSE: "مخزن", HR: "شؤون العاملين", MARKETING: "تسويق",
          FINANCE_APPROVER: "اعتماد مالي", SERVICE_ACCOUNT: "حساب خدمة",
        }[role] ?? role)
      : role.replace(/_/g, " ").toLowerCase();

  const when = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—";

  return (
    <>
      <PageHeader
        title={ar ? "المستخدمون" : "Users"}
        subtitle={
          ar
            ? "مين يقدر يدخل النظام، وبأي صلاحيات."
            : "Who may sign in, and what they may reach."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "حسابات شغالة" : "Active accounts"}
          value={formatNumber(active.length)}
        />
        <StatTile
          label={ar ? "ملاك" : "Owners"}
          value={formatNumber(owners.length)}
          hint={
            owners.length === 1
              ? ar ? "واحد بس — لو ضاع مفيش حد تاني" : "only one — no way back if lost"
              : undefined
          }
          tone={owners.length === 1 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "مقفولين مؤقتاً" : "Locked out"}
          value={formatNumber(locked.length)}
          tone={locked.length > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "لسه مغيّروش الباسورد" : "Password not yet theirs"}
          value={formatNumber(pending.length)}
          tone={pending.length > 0 ? "warn" : "good"}
        />
      </div>

      <div className="mb-5">
        <Card
          title={ar ? "حساب جديد" : "New account"}
          description={
            ar
              ? "اكتبله باسورد مؤقت وسلّمهوله — النظام هيجبره يغيّره أول ما يدخل، فمش هيفضل باسورد اتنين عارفينه."
              : "Give them a temporary password. The system makes them replace it before they can reach anything."
          }
        >
          <NewUserForm
            ar={ar}
            roles={roles.map((r) => ({
              role: r.role,
              label: roleLabel(r.role),
              permissionCount: r.permissionCount,
            }))}
          />
        </Card>
      </div>

      <Card title={ar ? "الحسابات" : "Accounts"}>
        <DataTable
          headers={[
            ar ? "الاسم" : "Name",
            ar ? "الإيميل" : "Email",
            ar ? "الدور" : "Role",
            ar ? "صلاحيات" : "Reach",
            ar ? "آخر دخول" : "Last signed in",
            ar ? "الحالة" : "State",
            "",
          ]}
          rows={users.map((u) => [
            <span key="n" className={u.isActive ? "font-medium text-ink-900" : "text-ink-400"}>
              {u.name}
              {u.id === session.userId && (
                <span className="ms-2 text-[11px] text-ink-400">
                  {ar ? "(انت)" : "(you)"}
                </span>
              )}
            </span>,
            <span key="e" className="num text-xs" dir="ltr">{u.email}</span>,
            <span key="r" className="text-sm">{roleLabel(u.role)}</span>,
            <span key="p" className="num text-xs text-ink-400">
              {u.role === "OWNER" ? (ar ? "كل حاجة" : "everything") : u.permissionCount}
            </span>,
            <span key="l" className="num text-xs" dir="ltr">{when(u.lastLoginAt)}</span>,
            <span key="s" className="flex flex-wrap items-center gap-1">
              {!u.isActive && <Badge tone="neutral">{ar ? "مقفول" : "off"}</Badge>}
              {u.isLocked && (
                <Badge tone="bad">
                  {ar ? `مقفول مؤقتاً (${u.failedLogins})` : `locked (${u.failedLogins})`}
                </Badge>
              )}
              {u.isActive && u.mustChangePassword && (
                <Badge tone="warn">{ar ? "باسورد مؤقت" : "temp password"}</Badge>
              )}
              {u.isActive && !u.isLocked && !u.mustChangePassword && (
                <Badge tone="good">{ar ? "شغال" : "active"}</Badge>
              )}
            </span>,
            <UserActions
              key="a"
              ar={ar}
              user={{
                id: u.id,
                name: u.name,
                role: u.role,
                isActive: u.isActive,
                isLocked: u.isLocked,
              }}
              isSelf={u.id === session.userId}
              isLastOwner={u.role === "OWNER" && owners.length === 1}
              roles={roles.map((r) => ({ role: r.role, label: roleLabel(r.role) }))}
            />,
          ])}
        />
      </Card>

      <p className="mt-4 text-xs text-ink-500">
        {ar
          ? "الحسابات مابتتمسحش أبداً — كل قيد وكل بيعة مكتوب عليها مين عملها، ومسح الحساب يضيّع ده. الحساب اللي مش المفروض يتستخدم بيتقفل."
          : "Accounts are never deleted: every journal line and sale names the person who made it. An account that should not be used is switched off instead."}
      </p>
    </>
  );
}
