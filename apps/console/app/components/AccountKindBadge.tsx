import { Badge } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/** The account chip (account name, or an "HD"/"PK" kind label) as a Kumo Badge. HD accounts use the
 *  neutral "secondary" variant. PK accounts carry the NETWORK ACCENT: no Kumo Badge variant fills with
 *  the brand (variant="primary" is inverted black), so the PK chip is a primary Badge whose fill is
 *  overridden — via Kumo's own cn() merge — with Kumo's brand token (re-pointed per network in
 *  globals.css) and Kumo's inverse text; the derived brand shades keep that text >= ~4.5:1. */
export function AccountKindBadge({ kind, children }: { kind: string; children: ReactNode }) {
  const content = <span title={kind === "HD" ? "助记词派生账户" : "私钥导入账户"}>{children}</span>;
  if (kind === "HD") return <Badge variant="secondary">{content}</Badge>;
  return <Badge variant="primary" className="bg-kumo-brand text-kumo-inverse">{content}</Badge>;
}
